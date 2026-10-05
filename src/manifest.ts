import { addressBookSyncExternalActions } from './operatorActions';
import type { PluginManifest } from '@wabs/plugin-sdk/manifest';
import { addressBookSyncConfigSchema } from './config';
import { addressBookSyncMessages } from './messages';

export const addressBookSyncManifest: PluginManifest = {
  pluginId: 'official.address-book-sync',
  kind: 'managed_group',
  version: '0.3.0',
  coreApiRange: '^0.3.11',
  messageNamespace: 'official.address-book-sync',
  descriptionKey: 'official.address-book-sync.description',
  defaultMessages: addressBookSyncMessages,
  commands: [],
  help: {
    featureId: 'address-book',
    titleKey: 'official.address-book-sync.help.feature.title',
    summaryKey: 'official.address-book-sync.help.feature.summary',
    order: 80,
    aliases: ['contacts', 'address book'],
    topics: [{
      topicId: 'sync-address-book',
      titleKey: 'official.address-book-sync.help.sync.title',
      summaryKey: 'official.address-book-sync.help.sync.summary',
      instructionKeys: ['official.address-book-sync.help.sync.instruction'],
      keywords: ['contacts', 'join', 'member', 'sync'],
      availability: { invocation: 'either', permission: 'plugin.configure' }
    }]
  },
  externalActions: addressBookSyncExternalActions,
  eventSubscriptions: ['participant.change', 'message', 'plugin.job'],
  requiredPermissions: ['plugin.configure'],
  requiredBotCapabilities: [],
  configSchema: addressBookSyncConfigSchema,
  dangerousActions: ['contact.saveToAddressBook'],
  backgroundJobs: ['contact-sync.reconcile', 'contact-sync.retry'],
  cancellation: { workflows: [] },
  assistant: {
    summary: 'Automatically saves unknown arriving members using push name, persisted display name, or username and supports explicit backfill and repair.',
    useCases: [
      'Explain whether unknown joining members will be saved to the address book.',
      'Summarize the configured suffix and event triggers.',
      'Backfill unknown current group participants after enabling the plugin.',
      'Repair historical plugin-saved phone fallback names when a push name or username is now available.',
      'Describe duplicate suppression for repeated participant-change events.'
    ],
    prerequisites: [
      'The plugin must be enabled in the target managed scope.',
      'The active transport must support WhatsApp address-book contact saves.',
      'The runtime must provide live group participant, profile-name, and contact lookup helpers.'
    ],
    limitations: [
      'Names that are not yet available remain pending and are retried automatically.',
      'WhatsApp clients may not reflect app-state contact saves uniformly across devices.'
    ]
  }
};
