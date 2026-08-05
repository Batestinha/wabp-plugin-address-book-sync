import type { StableIdentityAddressResolution } from '../../../platform/identity/identityAddressService';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type { PluginEphemeralStore } from '../../../platform/pluginRuntime/runtime/pluginEphemeralStore';
import type { PluginParticipantIdentity } from '../../../platform/pluginRuntime/types';
import type { GroupParticipant } from '../../../platform/transport/transportTypes';
import type { AddressBookSyncConfig } from './config';

export const ADDRESS_BOOK_SYNC_PLUGIN_ID = 'official.address-book-sync';

export type AddressBookSyncSkipReason =
  | 'self-recipient'
  | 'known-contact'
  | 'duplicate-event';

export interface AddressBookSyncTarget {
  scopeId: string;
  chatId: string;
  eventId?: string | undefined;
  participantAction?: string | undefined;
}

export interface AddressBookSyncRuntime {
  ephemeralStore: PluginEphemeralStore;
  isKnownContact(wid: string): Promise<boolean>;
  resolveIdentityAddress(wid: string): Promise<StableIdentityAddressResolution>;
}

export interface AddressBookSyncPlanInput {
  runtime: AddressBookSyncRuntime;
  target: AddressBookSyncTarget;
  config: AddressBookSyncConfig;
  participants: GroupParticipant[];
  targetIdentities: PluginParticipantIdentity[];
  botIdentityIds?: string[] | undefined;
  dryRun?: boolean | undefined;
  includeSkipAuditActions?: boolean | undefined;
}

export interface AddressBookSyncPlanResult {
  identityId: string;
  sourceWid: string;
  status: 'would_save' | 'save_requested' | 'skipped';
  saveWid?: string | undefined;
  displayName?: string | undefined;
  canonicalWid?: string | undefined;
  reason?: AddressBookSyncSkipReason | undefined;
}

export interface AddressBookSyncPlan {
  actions: PluginAction[];
  results: AddressBookSyncPlanResult[];
  summary: {
    scanned: number;
    saveRequests: number;
    wouldSave: number;
    skipped: number;
    skippedReasons: Record<string, number>;
  };
}

export async function planAddressBookSync(input: AddressBookSyncPlanInput): Promise<AddressBookSyncPlan> {
  const participantsByIdentityId = await participantMap(input.runtime, input.participants);
  const botIdentityIds = new Set(input.botIdentityIds ?? []);
  const actions: PluginAction[] = [];
  const results: AddressBookSyncPlanResult[] = [];

  for (const recipient of uniqueIdentities(input.targetIdentities)) {
    if (botIdentityIds.has(recipient.identityId)) {
      addSkipped(input, actions, results, recipient, 'self-recipient');
      continue;
    }
    if (await isKnownRecipient(input.runtime, recipient)) {
      addSkipped(input, actions, results, recipient, 'known-contact');
      continue;
    }

    const saveWid = preferredSaveWid(recipient);
    const participant = participantsByIdentityId.get(recipient.identityId);
    const displayName = appendSuffix(participant?.displayName?.trim() || saveWid, input.config.suffix);
    const duplicate = await isDuplicateSyncAttempt(input, recipient);
    if (duplicate) {
      addSkipped(input, actions, results, recipient, 'duplicate-event');
      continue;
    }

    if (input.dryRun) {
      results.push({
        identityId: recipient.identityId,
        sourceWid: recipient.sourceWid,
        status: 'would_save',
        saveWid,
        displayName,
        canonicalWid: recipient.canonicalWid
      });
      continue;
    }

    actions.push({
      type: 'contact.saveToAddressBook',
      wid: saveWid,
      displayName,
      sourceGroupWid: input.target.chatId,
      reason: ADDRESS_BOOK_SYNC_PLUGIN_ID
    });
    results.push({
      identityId: recipient.identityId,
      sourceWid: recipient.sourceWid,
      status: 'save_requested',
      saveWid,
      displayName,
      canonicalWid: recipient.canonicalWid
    });
  }

  return {
    actions,
    results,
    summary: summarize(results)
  };
}

function addSkipped(
  input: AddressBookSyncPlanInput,
  actions: PluginAction[],
  results: AddressBookSyncPlanResult[],
  recipient: PluginParticipantIdentity,
  reason: AddressBookSyncSkipReason
): void {
  if (input.includeSkipAuditActions) {
    actions.push(auditSkipped(input.target, recipient, reason));
  }
  results.push({
    identityId: recipient.identityId,
    sourceWid: recipient.sourceWid,
    status: 'skipped',
    reason,
    saveWid: preferredSaveWid(recipient),
    canonicalWid: recipient.canonicalWid
  });
}

async function isDuplicateSyncAttempt(
  input: AddressBookSyncPlanInput,
  recipient: PluginParticipantIdentity
): Promise<boolean> {
  const key = saveDedupeKey(input.target, recipient);
  if (input.dryRun) {
    const existing = await input.runtime.ephemeralStore.get<number>(key);
    return existing !== undefined;
  }
  const saveAttempt = await input.runtime.ephemeralStore.increment(key, input.config.dedupeTtlSeconds);
  return saveAttempt !== 1;
}

function summarize(results: AddressBookSyncPlanResult[]): AddressBookSyncPlan['summary'] {
  const skippedReasons: Record<string, number> = {};
  for (const result of results) {
    if (result.status === 'skipped' && result.reason) {
      skippedReasons[result.reason] = (skippedReasons[result.reason] ?? 0) + 1;
    }
  }
  return {
    scanned: results.length,
    saveRequests: results.filter((result) => result.status === 'save_requested').length,
    wouldSave: results.filter((result) => result.status === 'would_save').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    skippedReasons
  };
}

async function participantMap(
  runtime: AddressBookSyncRuntime,
  participants: GroupParticipant[]
): Promise<Map<string, GroupParticipant>> {
  const byIdentityId = new Map<string, GroupParticipant>();
  for (const participant of participants) {
    if (!participant.wid.trim()) continue;
    const identity = await runtime.resolveIdentityAddress(participant.wid);
    if (!byIdentityId.has(identity.identityId)) {
      byIdentityId.set(identity.identityId, participant);
    }
  }
  return byIdentityId;
}

async function isKnownRecipient(
  runtime: AddressBookSyncRuntime,
  recipient: PluginParticipantIdentity
): Promise<boolean> {
  return runtime.isKnownContact(recipient.addressBookWid);
}

function preferredSaveWid(recipient: PluginParticipantIdentity): string {
  return recipient.addressBookWid;
}

function appendSuffix(label: string, suffix: string): string {
  const normalizedLabel = label.trim();
  const normalizedSuffix = suffix.trim();
  if (!normalizedSuffix || normalizedLabel.endsWith(normalizedSuffix)) {
    return normalizedLabel;
  }
  return `${normalizedLabel} ${normalizedSuffix}`;
}

function saveDedupeKey(target: AddressBookSyncTarget, recipient: PluginParticipantIdentity): string {
  return `address-book-sync:save:${target.scopeId}:${target.chatId}:identity:${recipient.identityId}`;
}

function auditSkipped(
  target: AddressBookSyncTarget,
  recipient: PluginParticipantIdentity,
  reason: string
): PluginAction {
  return {
    type: 'audit.record',
    action: 'address-book-sync.skipped',
    targetJson: {
      pluginId: ADDRESS_BOOK_SYNC_PLUGIN_ID,
      scopeId: target.scopeId,
      chatId: target.chatId,
      ...(target.eventId ? { eventId: target.eventId } : {}),
      ...(target.participantAction ? { participantAction: target.participantAction } : {}),
      identityId: recipient.identityId,
      userWid: recipient.canonicalWid,
      sourceWid: recipient.sourceWid,
      saveWid: preferredSaveWid(recipient)
    },
    metadataJson: { reason }
  };
}

function uniqueIdentities(identities: PluginParticipantIdentity[]): PluginParticipantIdentity[] {
  const byIdentityId = new Map<string, PluginParticipantIdentity>();
  for (const identity of identities) {
    if (!byIdentityId.has(identity.identityId)) {
      byIdentityId.set(identity.identityId, identity);
    }
  }
  return [...byIdentityId.values()];
}
