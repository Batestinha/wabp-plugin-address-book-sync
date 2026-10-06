import type { MessageCatalog } from '@wabs/plugin-sdk/i18n';

export const addressBookSyncMessages: MessageCatalog = {
  'official.address-book-sync.description': 'Save unknown arriving group members using their push name, display name, or username, plus a configured suffix.',
  'official.address-book-sync.help.feature.title': 'Address book sync',
  'official.address-book-sync.help.feature.summary': 'Save unknown arriving members as contacts, waiting until a display name or username is available.',
  'official.address-book-sync.help.sync.title': 'Sync arriving members',
  'official.address-book-sync.help.sync.summary': 'Choose the best available profile name and apply the configured suffix when eligible members arrive.',
  'official.address-book-sync.help.sync.instruction': 'This feature runs automatically when enabled, waits for missing names, and repairs recorded plugin-created phone fallbacks or duplicated surnames while preserving manual edits. Administrators can reconcile members from the operator console.'
};
