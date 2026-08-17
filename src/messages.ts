import type { MessageCatalog } from '../../../platform/i18n';

export const addressBookSyncMessages: MessageCatalog = {
  'official.address-book-sync.description': 'Save unknown arriving group members using their push name, username, or phone number, plus a configured suffix.',
  'official.address-book-sync.help.feature.title': 'Address book sync',
  'official.address-book-sync.help.feature.summary': 'Save unknown arriving members as contacts, preferring push name, username, then phone number.',
  'official.address-book-sync.help.sync.title': 'Sync arriving members',
  'official.address-book-sync.help.sync.summary': 'Choose the best available profile name and apply the configured suffix when eligible members arrive.',
  'official.address-book-sync.help.sync.instruction': 'This feature runs automatically when enabled; administrators configure triggers and can backfill unknown members or repair historical phone fallback names from the operator console.'
};
