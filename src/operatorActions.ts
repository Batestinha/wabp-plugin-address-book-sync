import { z } from 'zod';
const runtimeGroupChatIdSchema = z.string().trim().regex(/^[^\s@]+@g\.us$/i).transform(value => value.toLowerCase());
export const addressBookSyncBackfillInputSchema = z.object({
    scopeId: z.string().trim().min(1),
    chatId: runtimeGroupChatIdSchema.optional(),
    participantWids: z.array(z.string().trim().min(1)).max(2000).optional(),
    mode: z.enum(['sync-members', 'unknown-members', 'repair-phone-fallbacks']).default('sync-members'),
    dryRun: z.boolean().default(true),
    actorWid: z.string().trim().min(1).optional()
  }).strict();
export const addressBookSyncExternalActions = [{
  actionId: 'official.address-book-sync.backfill', access: 'mutation' as const, scope: 'account' as const, timeoutMs: 120_000
}];
