import type { PluginAction } from '../../../platform/pluginRuntime/runtime/pluginActionTypes';
import type { PluginRuntimeContext } from '../../../platform/pluginRuntime/runtime/pluginRuntimeContext';
import type { PluginParticipantChangeEvent, PluginRuntimeHooks } from '../../../platform/pluginRuntime/types';
import { parseAddressBookSyncConfig, type AddressBookSyncConfig } from './config';
import { planAddressBookSync } from './sync';

const pluginId = 'official.address-book-sync';

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
      const plan = await planAddressBookSync({
        runtime: {
          ephemeralStore: context.ephemeralStore,
          isKnownContact: context.isKnownContact,
          resolveIdentityAddress: requiredIdentityAddressResolver(context.resolveIdentityAddress)
        },
        target: {
          scopeId: event.scopeId,
          chatId: event.chatId,
          eventId: event.eventId,
          participantAction: event.action
        },
        config,
        participants,
        targetWids: event.affectedWids,
        botWids: botRecipientWids(event),
        includeSkipAuditActions: true
      });

      return plan.actions;
    }
  };
}

function requiredIdentityAddressResolver(
  resolver: PluginRuntimeContext['resolveIdentityAddress']
): NonNullable<PluginRuntimeContext['resolveIdentityAddress']> {
  if (!resolver) throw new Error('Authoritative identity address service is unavailable.');
  return resolver;
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

function botRecipientWids(event: PluginParticipantChangeEvent): string[] {
  return [
    ...(event.botWid ? [event.botWid] : []),
    ...(event.botWids ?? [])
  ].map((wid) => wid.trim()).filter(Boolean);
}

function auditSkipped(
  event: PluginParticipantChangeEvent,
  _recipient: undefined,
  reason: string
): PluginAction {
  return {
    type: 'audit.record',
    action: 'address-book-sync.skipped',
    targetJson: {
      pluginId,
      scopeId: event.scopeId,
      chatId: event.chatId,
      eventId: event.eventId,
      participantAction: event.action
    },
    metadataJson: { reason }
  };
}
