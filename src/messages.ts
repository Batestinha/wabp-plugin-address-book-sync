import type { MessageCatalog } from '@wabs/plugin-sdk/i18n';

export const addressBookSyncMessages: MessageCatalog = {
  'official.address-book-sync.description': 'Saves group members to the bot’s WhatsApp contacts when it learns their names. Retries pending contacts and can repair phone-number labels or duplicate names it previously saved.',
  'official.address-book-sync.help.feature.title': 'Address book sync',
  'official.address-book-sync.help.feature.summary': 'Saves contacts once a member’s name is available and lets administrators review and repair contacts saved by the plugin.',
  'official.address-book-sync.help.sync.title': 'Sync arriving members',
  'official.address-book-sync.help.sync.summary': 'Choose the best available profile name and apply the configured suffix when eligible members arrive.',
  'official.address-book-sync.help.sync.instruction': 'This feature runs automatically when enabled, waits for missing names, and repairs recorded plugin-created phone fallbacks or duplicated surnames while preserving manual edits. Administrators can reconcile members from the operator console.'
};
