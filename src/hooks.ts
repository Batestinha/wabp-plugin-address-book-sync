import type { PrivateRecipientResolution } from '../../../platform/identity/privateRecipientResolver';
import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginParticipantChangeEvent, PluginRuntimeHooks } from '../../../platform/pluginRuntime/types';
import { parseAddressBookSyncConfig, type AddressBookSyncConfig } from './config';

const pluginId = 'official.address-book-sync';
type RuntimeGroupParticipant = Awaited<ReturnType<NonNullable<PluginRuntimeContext['getGroupParticipants']>>>[number];

export function createAddressBookSyncHooks(context: PluginRuntimeContext): PluginRuntimeHooks {
  return {
    async onParticipantChange(event) {
      const config = parseAddressBookSyncConfig(await context.configFor(event.scopeId, event.actorWid));
      if (!config.enabled || !shouldSaveForEvent(event, config)) {
        return;
      }
      if (exemptGroupChatIds(config).has(event.chatId)) {
        return [auditSkipped(event, undefined, 'exempt-group')];
      }
      if (!context.getGroupParticipants || !context.isKnownContact) {
        return [auditSkipped(event, undefined, 'missing-runtime-api')];
      }

      const participants = await context.getGroupParticipants(event.chatId);
      const participantsByWid = participantMap(participants);
      const botRecipients = botRecipientWids(event);
      const actions: PluginAction[] = [];

      for (const eventUserWid of uniqueWids(event.affectedWids)) {
        const recipient = await resolveRecipient(context, eventUserWid);
        if (recipientAliases(recipient).some((alias) => botRecipients.has(alias))) {
          actions.push(auditSkipped(event, recipient, 'self-recipient'));
          continue;
        }
        if (await isKnownRecipient(context, recipient)) {
          actions.push(auditSkipped(event, recipient, 'known-contact'));
          continue;
        }

        const saveWid = preferredSaveWid(recipient);
        const participant = participantForRecipient(participantsByWid, recipient);
        const displayName = appendSuffix(participant?.displayName?.trim() || saveWid, config.suffix);
        const saveAttempt = await context.ephemeralStore.increment(saveDedupeKey(event, recipient), config.dedupeTtlSeconds);
        if (saveAttempt !== 1) {
          actions.push(auditSkipped(event, recipient, 'duplicate-event'));
          continue;
        }
        actions.push({
          type: 'contact.saveToAddressBook',
          wid: saveWid,
          displayName,
          sourceGroupWid: event.chatId,
          reason: pluginId
        });
      }

      return actions;
    }
  };
}

function shouldSaveForEvent(event: PluginParticipantChangeEvent, config: AddressBookSyncConfig): boolean {
  if (event.action === 'join') {
    return config.saveOnJoin;
  }
  if (event.action === 'add') {
    return config.saveOnAdd;
  }
  if (event.action === 'membership_approved') {
    return config.saveOnApproval;
  }
  return false;
}

function exemptGroupChatIds(config: AddressBookSyncConfig): Set<string> {
  return new Set(config.exemptGroupChatIds.map((chatId) => chatId.trim()).filter(Boolean));
}

async function resolveRecipient(
  context: PluginRuntimeContext,
  userWid: string
): Promise<PrivateRecipientResolution> {
  return context.resolvePrivateRecipient?.(userWid) ?? unresolvedRecipient(userWid);
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

function participantMap(participants: RuntimeGroupParticipant[]): Map<string, RuntimeGroupParticipant> {
  return new Map(
    participants
      .filter((participant) => participant.wid.trim())
      .map((participant) => [participant.wid, participant])
  );
}

function participantForRecipient(
  participantsByWid: Map<string, RuntimeGroupParticipant>,
  recipient: PrivateRecipientResolution
): RuntimeGroupParticipant | undefined {
  for (const wid of recipientAliases(recipient)) {
    const participant = participantsByWid.get(wid);
    if (participant) {
      return participant;
    }
  }
  return undefined;
}

async function isKnownRecipient(
  context: PluginRuntimeContext,
  recipient: PrivateRecipientResolution
): Promise<boolean> {
  for (const wid of recipientAliases(recipient)) {
    if (await context.isKnownContact?.(wid)) {
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

function saveDedupeKey(event: PluginParticipantChangeEvent, recipient: PrivateRecipientResolution): string {
  return `address-book-sync:save:${event.scopeId}:${event.chatId}:${recipient.dedupeKey}`;
}

function botRecipientWids(event: PluginParticipantChangeEvent): Set<string> {
  return new Set([
    ...(event.botWid ? [event.botWid] : []),
    ...(event.botWids ?? [])
  ].map((wid) => wid.trim()).filter(Boolean));
}

function uniqueWids(wids: string[]): string[] {
  return [...new Set(wids.map((wid) => wid.trim()).filter(Boolean))];
}

function auditSkipped(
  event: PluginParticipantChangeEvent,
  recipient: PrivateRecipientResolution | undefined,
  reason: string
): PluginAction {
  return {
    type: 'audit.record',
    action: 'address-book-sync.skipped',
    targetJson: target(event, recipient),
    metadataJson: { reason }
  };
}

function target(event: PluginParticipantChangeEvent, recipient: PrivateRecipientResolution | undefined): Record<string, unknown> {
  return {
    pluginId,
    scopeId: event.scopeId,
    chatId: event.chatId,
    eventId: event.eventId,
    participantAction: event.action,
    ...(recipient ? {
      userWid: recipient.canonicalWid,
      eventUserWid: recipient.originalWid,
      saveWid: preferredSaveWid(recipient),
      aliases: recipient.aliases
    } : {})
  };
}
