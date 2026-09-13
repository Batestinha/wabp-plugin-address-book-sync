import { z } from 'zod';
import type { PluginOperatorActionContext, PluginOperatorCapabilities } from '@wabs/plugin-sdk/operator-actions';
import type { PluginExternalActionRegistration } from '@wabs/plugin-sdk/external-actions';
import { resolvePluginParticipantIdentities } from '@wabs/plugin-sdk/participant-identity';
import { parseAddressBookSyncConfig, type AddressBookSyncConfig } from './config';
import { ADDRESS_BOOK_SYNC_PLUGIN_ID, planAddressBookSync } from './sync';
import { findAddressBookSyncRepairCandidates, planAddressBookSyncRepairs } from './repair';
import { addressBookSyncBackfillInputSchema } from './operatorActions';

const OPERATOR_CONSOLE_ACTOR_WID = 'operator-console@system';
const ADDRESS_BOOK_SYNC_BACKFILL_RESULT_LIMIT = 200;
type AddressBookOperatorContext = PluginOperatorActionContext & {
  [Key in 'operator' | 'resolveIdentityAddress' | 'coveredGroupsForScope']: NonNullable<PluginOperatorActionContext[Key]>
};

export function registerAddressBookSyncExternalActions(context: PluginOperatorActionContext): PluginExternalActionRegistration[] {
  return [{ actionId: 'official.address-book-sync.backfill', inputSchema: addressBookSyncBackfillInputSchema,
    outputSchema: z.record(z.unknown()), handler: async (body, call) => {
      call.signal.throwIfAborted();
      if (!context.operator || !context.resolveIdentityAddress || !context.coveredGroupsForScope) {
        throw new Error('Host operator contact and scope capabilities are unavailable.');
      }
      return backfillAddressBookSync(body, context as AddressBookOperatorContext);
    }
  }];
}

async function backfillAddressBookSync(
  body: unknown,
  input: AddressBookOperatorContext
): Promise<unknown> {
  const parsed = addressBookSyncBackfillInputSchema.parse(body);
  if (!parsed.chatId && parsed.participantWids?.length) {
    throw httpError(400, 'participantWids can only be used when chatId is provided.');
  }
  const actorIdentityId = (
    await input.resolveIdentityAddress(parsed.actorWid || OPERATOR_CONSOLE_ACTOR_WID)
  ).identityId;
  const config = parseAddressBookSyncConfig(
    await input.configFor(parsed.scopeId, actorIdentityId)
  );
  if (parsed.mode === 'repair-phone-fallbacks') {
    if (parsed.participantWids?.length) {
      throw httpError(400, 'participantWids cannot be used when repairing historical phone fallback names.');
    }
    if (parsed.chatId) {
      const repairScope = await input.operator.resolveCoveredGroup(parsed.scopeId, parsed.chatId);
      if (!repairScope) {
        throw httpError(409, `Group ${parsed.chatId} is not covered by scope ${parsed.scopeId}.`);
      }
      if (!parsed.dryRun && repairScope.managementMode !== 'MANAGE') {
        throw httpError(409, `Address book repair requires MANAGE mode; ${parsed.chatId} is currently ${repairScope.managementMode}.`);
      }
    }
    return repairAddressBookSyncPhoneFallbacks(parsed, input, actorIdentityId);
  }
  const scopes = parsed.chatId
    ? [await input.operator.resolveCoveredGroup(parsed.scopeId, parsed.chatId)]
    : await input.coveredGroupsForScope(parsed.scopeId);
  const targetScopes = scopes.filter((scope): scope is AddressBookSyncBackfillScope => Boolean(scope));

  if (parsed.chatId && targetScopes.length === 0) {
    throw httpError(409, `Group ${parsed.chatId} is not covered by scope ${parsed.scopeId}.`);
  }

  if (!config.enabled && !parsed.dryRun) {
    throw httpError(409, 'official.address-book-sync must be enabled for this scope before running backfill.');
  }

  const groupResults = [];
  for (const scope of targetScopes) {
    if (!parsed.dryRun && scope.managementMode !== 'MANAGE') {
      if (parsed.chatId) {
        throw httpError(409, `Address book backfill requires MANAGE mode; ${scope.groupWid} is currently ${scope.managementMode}.`);
      }
      groupResults.push(addressBookSyncBackfillSkippedGroupResult(parsed, scope, 'not-manage-mode'));
      continue;
    }
    if (!config.enabled) {
      groupResults.push(addressBookSyncBackfillSkippedGroupResult(parsed, scope, 'plugin-disabled'));
      continue;
    }
    if (config.exemptGroupChatIds.map((chatId) => chatId.trim()).includes(scope.groupWid)) {
      groupResults.push(addressBookSyncBackfillSkippedGroupResult(parsed, scope, 'exempt-group'));
      continue;
    }

    groupResults.push(await backfillAddressBookSyncGroup(parsed, scope, config, input, actorIdentityId));
  }

  const result = summarizeAddressBookSyncBackfill(parsed, config.enabled, groupResults);

  if (targetScopes.length > 0) {
    await input.audit.record({
      actorIdentityId,
      scopeId: parsed.scopeId,
      ...(parsed.chatId && targetScopes[0]?.groupId ? { groupId: targetScopes[0].groupId } : {}),
      action: parsed.dryRun ? 'address-book-sync.backfill_dry_run' : 'address-book-sync.backfill_run',
      targetJson: {
        pluginId: ADDRESS_BOOK_SYNC_PLUGIN_ID,
        scopeId: parsed.scopeId,
        ...(parsed.chatId ? { chatId: parsed.chatId } : {})
      },
      metadataJson: {
        groupCount: targetScopes.length,
        summary: {
          scanned: result.scanned,
          saveRequests: result.saveRequests,
          wouldSave: result.wouldSave,
          skipped: result.skipped,
          skippedReasons: result.skippedReasons
        }
      }
    });
  }

  return result;
}

type AddressBookSyncBackfillInput = z.infer<typeof addressBookSyncBackfillInputSchema>;

async function repairAddressBookSyncPhoneFallbacks(
  parsed: AddressBookSyncBackfillInput,
  input: AddressBookOperatorContext,
  actorIdentityId: string
): Promise<Record<string, unknown>> {
  const auditRows = await input.operator.readExecutedActions({ scopeId: parsed.scopeId, actionType: 'contact.saveToAddressBook' });
  const knownContacts = await input.operator.transport.getKnownContacts();
  const candidateDiscovery = findAddressBookSyncRepairCandidates({
    auditRows,
    knownContacts,
    ...(parsed.chatId ? { chatId: parsed.chatId } : {})
  });
  const profiles = await getAddressBookProfileNamesInBatches(
    input.operator.transport,
    candidateDiscovery.candidates.map((candidate) => candidate.wid)
  );
  const plan = planAddressBookSyncRepairs({
    candidates: candidateDiscovery.candidates,
    preliminaryResults: candidateDiscovery.preliminaryResults,
    profiles,
    dryRun: parsed.dryRun
  });
  for (const repair of plan.repairs) {
    if (!parsed.dryRun) {
      await input.operator.executeActions({

        scopeId: parsed.scopeId,
        actorIdentityId,
        groupId: repair.candidate.groupId,
        groupWid: repair.candidate.sourceGroupWid,
        actions: [{
          type: 'contact.saveToAddressBook',
          wid: repair.candidate.wid,
          contactName: repair.contactName,
          sourceGroupWid: repair.candidate.sourceGroupWid,
          reason: 'official.address-book-sync.repair-phone-fallback'
        }]
      });
    }
  }

  const skippedReasons: Record<string, number> = {};
  for (const result of plan.results) {
    if (result.status === 'skipped' && result.reason) {
      skippedReasons[result.reason] = (skippedReasons[result.reason] ?? 0) + 1;
    }
  }
  const summary = {
    auditedContactSaves: auditRows.length,
    nonPhoneFallbackSaves: candidateDiscovery.nonPhoneFallbackCount,
    eligiblePhoneFallbacks: candidateDiscovery.candidates.length,
    repairRequests: plan.results.filter((result) => result.status === 'repair_requested').length,
    wouldRepair: plan.results.filter((result) => result.status === 'would_repair').length,
    skipped: plan.results.filter((result) => result.status === 'skipped').length,
    skippedReasons
  };
  await input.audit.record({
    actorIdentityId,
    scopeId: parsed.scopeId,
    action: parsed.dryRun
      ? 'address-book-sync.phone_name_repair_dry_run'
      : 'address-book-sync.phone_name_repair_run',
    targetJson: {
      pluginId: ADDRESS_BOOK_SYNC_PLUGIN_ID,
      scopeId: parsed.scopeId,
      ...(parsed.chatId ? { chatId: parsed.chatId } : {})
    },
    metadataJson: summary
  });
  return {
    pluginId: ADDRESS_BOOK_SYNC_PLUGIN_ID,
    mode: parsed.mode,
    scopeId: parsed.scopeId,
    ...(parsed.chatId ? { chatId: parsed.chatId } : {}),
    dryRun: parsed.dryRun,
    ...summary,
    results: plan.results.slice(0, ADDRESS_BOOK_SYNC_BACKFILL_RESULT_LIMIT),
    resultLimit: ADDRESS_BOOK_SYNC_BACKFILL_RESULT_LIMIT,
    resultsTruncated: plan.results.length > ADDRESS_BOOK_SYNC_BACKFILL_RESULT_LIMIT
  };
}

async function getAddressBookProfileNamesInBatches(
  transport: PluginOperatorCapabilities['transport'],
  wids: string[]
): Promise<Awaited<ReturnType<PluginOperatorCapabilities['transport']['getUserProfileNames']>>> {
  const profiles: Awaited<ReturnType<PluginOperatorCapabilities['transport']['getUserProfileNames']>> = [];
  for (let offset = 0; offset < wids.length; offset += 512) {
    profiles.push(...await transport.getUserProfileNames(wids.slice(offset, offset + 512)));
  }
  return profiles;
}

interface AddressBookSyncBackfillScope {
  scopeId: string;
  groupId: string;
  groupWid: string;
  groupDisplayName?: string | undefined;
  managementMode: 'OBSERVE' | 'ASSIST' | 'MANAGE';
}

interface AddressBookSyncBackfillGroupResult {
  chatId: string;
  groupId: string;
  groupDisplayName?: string | undefined;
  managementMode: 'OBSERVE' | 'ASSIST' | 'MANAGE';
  participantCount: number;
  targetCount: number;
  scanned: number;
  saveRequests: number;
  wouldSave: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  results: unknown[];
  resultLimit: number;
  resultsTruncated: boolean;
  skippedGroupReason?: string | undefined;
}

async function backfillAddressBookSyncGroup(
  parsed: AddressBookSyncBackfillInput,
  scope: AddressBookSyncBackfillScope,
  config: AddressBookSyncConfig,
  input: AddressBookOperatorContext,
  actorIdentityId: string
): Promise<AddressBookSyncBackfillGroupResult> {
  const participants = await input.operator.transport.getGroupParticipants(scope.groupWid);
  const targetWids = parsed.participantWids?.length
    ? parsed.participantWids
    : participants.map((participant) => participant.wid);
  const targetIdentities = await resolvePluginParticipantIdentities(
    targetWids,
    (wid) => input.resolveIdentityAddress(wid)
  );
  const botIdentityId = input.operator.getCurrentBotIdentityId();
  const plan = await planAddressBookSync({
    runtime: {
      ephemeralStore: input.ephemeralStore,
      isKnownContact: (wid) => input.operator.transport.isKnownContact(wid),
      getUserProfileNames: (wids) => input.operator.transport.getUserProfileNames(wids),
      resolveIdentityAddress: (wid) => input.resolveIdentityAddress(wid)
    },
    target: {
      scopeId: parsed.scopeId,
      chatId: scope.groupWid,
      participantAction: 'backfill'
    },
    config,
    targetIdentities,
    botIdentityIds: botIdentityId ? [botIdentityId] : [],
    dryRun: parsed.dryRun
  });

  if (!parsed.dryRun && plan.actions.length > 0) {
    await input.operator.executeActions({

      scopeId: parsed.scopeId,
      actorIdentityId,
      groupId: scope.groupId,
      groupWid: scope.groupWid,
      actions: plan.actions
    });
  }

  return {
    chatId: scope.groupWid,
    groupId: scope.groupId,
    ...(scope.groupDisplayName ? { groupDisplayName: scope.groupDisplayName } : {}),
    managementMode: scope.managementMode,
    participantCount: participants.length,
    targetCount: targetWids.length,
    ...plan.summary,
    results: plan.results.slice(0, ADDRESS_BOOK_SYNC_BACKFILL_RESULT_LIMIT),
    resultLimit: ADDRESS_BOOK_SYNC_BACKFILL_RESULT_LIMIT,
    resultsTruncated: plan.results.length > ADDRESS_BOOK_SYNC_BACKFILL_RESULT_LIMIT
  };
}

function summarizeAddressBookSyncBackfill(
  parsed: AddressBookSyncBackfillInput,
  enabled: boolean,
  groupResults: AddressBookSyncBackfillGroupResult[]
): Record<string, unknown> {
  const skippedReasons: Record<string, number> = {};
  const totals = {
    participantCount: 0,
    targetCount: 0,
    scanned: 0,
    saveRequests: 0,
    wouldSave: 0,
    skipped: 0
  };
  for (const group of groupResults) {
    totals.participantCount += group.participantCount;
    totals.targetCount += group.targetCount;
    totals.scanned += group.scanned;
    totals.saveRequests += group.saveRequests;
    totals.wouldSave += group.wouldSave;
    totals.skipped += group.skipped;
    for (const [reason, count] of Object.entries(group.skippedReasons)) {
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + count;
    }
  }
  return {
    pluginId: ADDRESS_BOOK_SYNC_PLUGIN_ID,
    scopeId: parsed.scopeId,
    ...(parsed.chatId ? { chatId: parsed.chatId } : {}),
    dryRun: parsed.dryRun,
    enabled,
    groupCount: groupResults.length,
    processedGroupCount: groupResults.filter((group) => !group.skippedGroupReason).length,
    skippedGroupCount: groupResults.filter((group) => group.skippedGroupReason).length,
    ...totals,
    skippedReasons,
    groups: groupResults
  };
}

function addressBookSyncBackfillSkippedGroupResult(
  _parsed: AddressBookSyncBackfillInput,
  scope: AddressBookSyncBackfillScope,
  reason: string
): AddressBookSyncBackfillGroupResult {
  return {
    chatId: scope.groupWid,
    groupId: scope.groupId,
    ...(scope.groupDisplayName ? { groupDisplayName: scope.groupDisplayName } : {}),
    managementMode: scope.managementMode,
    participantCount: 0,
    targetCount: 0,
    scanned: 0,
    saveRequests: 0,
    wouldSave: 0,
    skipped: 0,
    skippedReasons: { [reason]: 1 },
    results: [],
    resultLimit: ADDRESS_BOOK_SYNC_BACKFILL_RESULT_LIMIT,
    resultsTruncated: false,
    skippedGroupReason: reason
  };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
