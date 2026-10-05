import { z } from 'zod';
import type { PluginOperatorActionContext } from '@wabs/plugin-sdk/operator-actions';
import { createContactReconciler } from './reconcile';
import { addressBookSyncBackfillInputSchema } from './operatorActions';

export function registerAddressBookSyncExternalActions(context: PluginOperatorActionContext) {
  const reconciler = createContactReconciler(context);
  return [{ actionId: 'official.address-book-sync.backfill', inputSchema: addressBookSyncBackfillInputSchema,
    outputSchema: z.record(z.unknown()), handler: async (body: unknown, call: { signal: AbortSignal }) => {
      const input = addressBookSyncBackfillInputSchema.parse(body);
      if (!input.chatId && input.participantWids?.length) throw Object.assign(new Error('participantWids requires chatId.'), { statusCode: 400 });
      if (input.mode === 'repair-phone-fallbacks' && input.participantWids?.length) throw Object.assign(new Error('Repair mode does not accept participantWids.'), { statusCode: 400 });
      const result = await reconciler.run({ ...input, force: true, signal: call.signal });
      await context.audit.record({ scopeId: input.scopeId,
        action: input.dryRun ? 'address-book-sync.backfill_dry_run' : 'address-book-sync.backfill_run',
        targetJson: { pluginId: context.pluginId, scopeId: input.scopeId },
        metadataJson: { scanned: result.scanned, saved: result.saved, repaired: result.repaired,
          pendingNames: result.pendingNames, retryScheduled: result.retryScheduled, failed: result.failed } });
      return result;
    } }];
}
