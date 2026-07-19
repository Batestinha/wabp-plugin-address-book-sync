import { z } from 'zod';

export const DEFAULT_ADDRESS_BOOK_SYNC_SUFFIX = '(Escalada)';

export const addressBookSyncConfigSchema = z.object({
  enabled: z.boolean().default(false),
  saveOnJoin: z.boolean().default(true),
  saveOnAdd: z.boolean().default(true),
  saveOnApproval: z.boolean().default(true),
  suffix: z.string().trim().min(1).default(DEFAULT_ADDRESS_BOOK_SYNC_SUFFIX),
  exemptGroupChatIds: z.array(z.string().trim().min(1)).default([]),
  dedupeTtlSeconds: z.number().int().positive().default(86_400)
}).default({});

export type AddressBookSyncConfig = z.infer<typeof addressBookSyncConfigSchema>;

export function parseAddressBookSyncConfig(value: unknown): AddressBookSyncConfig {
  return addressBookSyncConfigSchema.parse(value);
}
