import type { PluginHookContext } from '@wabs/plugin-sdk/hook-plugin';
import type { PluginRuntimeHooks } from '@wabs/plugin-sdk/hooks';
import { parseAddressBookSyncConfig } from './config';
import { createContactReconciler, SCAN_JOB, RETRY_JOB, SCAN_INTERVAL_MS } from './reconcile';

export function createAddressBookSyncHooks(context: PluginHookContext): PluginRuntimeHooks {
  const reconciler = createContactReconciler(context);
  return {
    onRuntimeReady: () => reconciler.ready(),
    async onParticipantChange(event) {
      const config = parseAddressBookSyncConfig(await context.configFor(event.scopeId, event.actorIdentity?.identityId));
      const enabledArrival = event.action === 'join' ? config.saveOnJoin
        : event.action === 'add' ? config.saveOnAdd : event.action === 'membership_approved' && config.saveOnApproval;
      if (!config.enabled || !enabledArrival || config.exemptGroupChatIds.includes(event.chatId)) return;
      if (!context.enqueuePluginJob) throw new Error('Durable contact job scheduling is unavailable.');
      const wids = event.affectedIdentities.filter(person => !event.botIdentityIds.includes(person.identityId)).map(person => person.addressBookWid);
      if (!wids.length) return;
      await context.enqueuePluginJob({ jobName: RETRY_JOB, scopeId: event.scopeId, groupId: event.groupId, groupWid: event.chatId,
        payload: { wids, arrivalAction: event.action }, dedupeKey: `contact-sync:arrival:${event.scopeId}:${event.eventId}`, replaceRetainedTerminalJob: true });
    },
    async onMessage(event) {
      if (event.message.fromMe || event.message.context !== 'group') return;
      const config = parseAddressBookSyncConfig(await context.configFor(event.scopeId));
      if (!config.enabled || config.exemptGroupChatIds.includes(event.message.chatId)) return;
      if (!context.enqueuePluginJob) throw new Error('Durable contact job scheduling is unavailable.');
      await context.enqueuePluginJob({ jobName: RETRY_JOB, scopeId: event.scopeId, groupWid: event.message.chatId,
        executionClass: 'maintenance', payload: { wids: [event.actorWid], wake: true },
        dedupeKey: `contact-sync:message:${event.scopeId}:${event.actorIdentityId}:${Math.floor(Date.now() / 60_000)}` });
    },
    async onPluginJob(job) {
      if (job.jobName === SCAN_JOB) {
        try { await reconciler.run({ scopeId: job.scopeId, automatic: true }); }
        finally { await reconciler.scheduleScan(job.scopeId, Date.now() + SCAN_INTERVAL_MS); }
      } else if (job.jobName === RETRY_JOB) {
        const payload = job.payload as { identityId?: string; wids?: string[]; arrivalAction?: string; wake?: boolean };
        if (payload.identityId) await reconciler.retry(job.scopeId, payload.identityId);
        else if (Array.isArray(payload.wids)) {
          const config = parseAddressBookSyncConfig(await context.configFor(job.scopeId));
          const allowed = payload.arrivalAction === 'join' ? config.saveOnJoin
            : payload.arrivalAction === 'add' ? config.saveOnAdd : payload.arrivalAction === 'membership_approved' && config.saveOnApproval;
          if (payload.arrivalAction && !allowed) return;
          await reconciler.run({ scopeId: job.scopeId, participantWids: payload.wids, automatic: true,
            allowNew: Boolean(payload.arrivalAction), force: payload.wake === true });
        }
      }
    }
  };
}
