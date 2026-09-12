import type { PluginAction } from '../../../../packages/plugin-sdk/src/actions';
import type { PluginHookContext as PluginRuntimeContext } from '../../../../packages/plugin-sdk/src/hook-plugin';
import type { PluginParticipantChangeEvent, PluginRuntimeHooks } from '../../../../packages/plugin-sdk/src/hooks';
import type { StableIdentityAddressResolution } from '../../../../packages/plugin-sdk/src/identity';
import { parseAddressBookSyncConfig, type AddressBookSyncConfig } from './config';
import { planAddressBookSync } from './sync';

const pluginId = 'official.address-book-sync';

export function createAddressBookSyncHooks(context: PluginRuntimeContext): PluginRuntimeHooks {
  return {
    async onParticipantChange(event) {
      const config = parseAddressBookSyncConfig(await context.configFor(
        event.scopeId,
        event.actorIdentity?.identityId
      ));
      if (!config.enabled || !shouldSaveForEvent(event, config)) {
        return;
      }
      if (exemptGroupChatIds(config).has(event.chatId)) {
        return [auditSkipped(event, undefined, 'exempt-group')];
      }
      if (!context.getUserProfileNames || !context.isKnownContact) {
        return [auditSkipped(event, undefined, 'missing-runtime-api')];
      }

      const plan = await planAddressBookSync({
        runtime: {
          ephemeralStore: context.ephemeralStore,
          isKnownContact: context.isKnownContact,
          getUserProfileNames: context.getUserProfileNames,
          resolveIdentityAddress: requiredIdentityAddressResolver(context.resolveIdentityAddress)
        },
        target: {
          scopeId: event.scopeId,
          chatId: event.chatId,
          eventId: event.eventId,
          participantAction: event.action
        },
        config,
        targetIdentities: event.affectedIdentities,
        botIdentityIds: event.botIdentityIds,
        includeSkipAuditActions: true
      });

      return plan.actions;
    }
  };
}

function requiredIdentityAddressResolver(
  resolver: PluginRuntimeContext['resolveIdentityAddress']
): (wid: string) => Promise<StableIdentityAddressResolution> {
  if (!resolver) throw new Error('Authoritative identity address service is unavailable.');
  return async (wid) => {
    const resolution = await resolver(wid);
    if (!resolution.identityId) {
      throw new Error(`Authoritative identity is unavailable for WhatsApp address ${wid}.`);
    }
    return resolution as StableIdentityAddressResolution;
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
