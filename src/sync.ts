import type { PrivateRecipientResolution } from '../../../platform/identity/privateRecipientResolver';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type { PluginEphemeralStore } from '../../../platform/pluginRuntime/runtime/pluginEphemeralStore';
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
  resolvePrivateRecipient?(wid: string): Promise<PrivateRecipientResolution>;
}

export interface AddressBookSyncPlanInput {
  runtime: AddressBookSyncRuntime;
  target: AddressBookSyncTarget;
  config: AddressBookSyncConfig;
  participants: GroupParticipant[];
  targetWids: string[];
  botWids?: string[] | undefined;
  dryRun?: boolean | undefined;
  includeSkipAuditActions?: boolean | undefined;
}

export interface AddressBookSyncPlanResult {
  eventUserWid: string;
  status: 'would_save' | 'save_requested' | 'skipped';
  saveWid?: string | undefined;
  displayName?: string | undefined;
  canonicalWid?: string | undefined;
  aliases?: string[] | undefined;
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
  const participantsByWid = participantMap(input.participants);
  const botRecipients = new Set(uniqueWids(input.botWids ?? []));
  const actions: PluginAction[] = [];
  const results: AddressBookSyncPlanResult[] = [];

  for (const eventUserWid of uniqueWids(input.targetWids)) {
    const recipient = await resolveRecipient(input.runtime, eventUserWid);
    if (recipientAliases(recipient).some((alias) => botRecipients.has(alias))) {
      addSkipped(input, actions, results, eventUserWid, recipient, 'self-recipient');
      continue;
    }
    if (await isKnownRecipient(input.runtime, recipient)) {
      addSkipped(input, actions, results, eventUserWid, recipient, 'known-contact');
      continue;
    }

    const saveWid = preferredSaveWid(recipient);
    const participant = participantForRecipient(participantsByWid, recipient);
    const displayName = appendSuffix(participant?.displayName?.trim() || saveWid, input.config.suffix);
    const duplicate = await isDuplicateSyncAttempt(input, recipient);
    if (duplicate) {
      addSkipped(input, actions, results, eventUserWid, recipient, 'duplicate-event');
      continue;
    }

    if (input.dryRun) {
      results.push({
        eventUserWid,
        status: 'would_save',
        saveWid,
        displayName,
        canonicalWid: recipient.canonicalWid,
        aliases: recipient.aliases
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
      eventUserWid,
      status: 'save_requested',
      saveWid,
      displayName,
      canonicalWid: recipient.canonicalWid,
      aliases: recipient.aliases
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
  eventUserWid: string,
  recipient: PrivateRecipientResolution,
  reason: AddressBookSyncSkipReason
): void {
  if (input.includeSkipAuditActions) {
    actions.push(auditSkipped(input.target, recipient, reason));
  }
  results.push({
    eventUserWid,
    status: 'skipped',
    reason,
    saveWid: preferredSaveWid(recipient),
    canonicalWid: recipient.canonicalWid,
    aliases: recipient.aliases
  });
}

async function isDuplicateSyncAttempt(
  input: AddressBookSyncPlanInput,
  recipient: PrivateRecipientResolution
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

function participantMap(participants: GroupParticipant[]): Map<string, GroupParticipant> {
  return new Map(
    participants
      .filter((participant) => participant.wid.trim())
      .map((participant) => [participant.wid, participant])
  );
}

function participantForRecipient(
  participantsByWid: Map<string, GroupParticipant>,
  recipient: PrivateRecipientResolution
): GroupParticipant | undefined {
  for (const wid of recipientAliases(recipient)) {
    const participant = participantsByWid.get(wid);
    if (participant) {
      return participant;
    }
  }
  return undefined;
}

async function resolveRecipient(
  runtime: AddressBookSyncRuntime,
  userWid: string
): Promise<PrivateRecipientResolution> {
  return runtime.resolvePrivateRecipient?.(userWid) ?? unresolvedRecipient(userWid);
}

function unresolvedRecipient(userWid: string): PrivateRecipientResolution {
  return {
    originalWid: userWid,
    chatId: userWid,
    deliveryChatIds: userWid ? [userWid] : [],
    canonicalWid: userWid,
    aliases: userWid ? [userWid] : [],
    dedupeKey: `wid:${userWid}`
  };
}

async function isKnownRecipient(
  runtime: AddressBookSyncRuntime,
  recipient: PrivateRecipientResolution
): Promise<boolean> {
  for (const wid of recipientAliases(recipient)) {
    if (await runtime.isKnownContact(wid)) {
      return true;
    }
  }
  return false;
}

function preferredSaveWid(recipient: PrivateRecipientResolution): string {
  return recipient.deliveryChatIds.find((wid) => wid.endsWith('@c.us')) ??
    recipient.aliases.find((wid) => wid.endsWith('@c.us')) ??
    recipient.deliveryChatIds.find((wid) => wid.endsWith('@s.whatsapp.net')) ??
    recipient.aliases.find((wid) => wid.endsWith('@s.whatsapp.net')) ??
    recipient.deliveryChatIds.find((wid) => wid.endsWith('@lid')) ??
    recipient.aliases.find((wid) => wid.endsWith('@lid')) ??
    recipient.canonicalWid;
}

function recipientAliases(recipient: PrivateRecipientResolution): string[] {
  return uniqueWids([
    recipient.originalWid,
    recipient.chatId,
    recipient.canonicalWid,
    ...recipient.deliveryChatIds,
    ...recipient.aliases
  ]);
}

function appendSuffix(label: string, suffix: string): string {
  const normalizedLabel = label.trim();
  const normalizedSuffix = suffix.trim();
  if (!normalizedSuffix || normalizedLabel.endsWith(normalizedSuffix)) {
    return normalizedLabel;
  }
  return `${normalizedLabel} ${normalizedSuffix}`;
}

function saveDedupeKey(target: AddressBookSyncTarget, recipient: PrivateRecipientResolution): string {
  return `address-book-sync:save:${target.scopeId}:${target.chatId}:${recipient.dedupeKey}`;
}

function auditSkipped(
  target: AddressBookSyncTarget,
  recipient: PrivateRecipientResolution,
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
      userWid: recipient.canonicalWid,
      eventUserWid: recipient.originalWid,
      saveWid: preferredSaveWid(recipient),
      aliases: recipient.aliases
    },
    metadataJson: { reason }
  };
}

function uniqueWids(wids: string[]): string[] {
  return [...new Set(wids.map((wid) => wid.trim()).filter(Boolean))];
}
