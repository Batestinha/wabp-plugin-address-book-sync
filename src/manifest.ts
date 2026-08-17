import type { PluginManifest } from '../../../platform/pluginRuntime/manifest';
import { addressBookSyncConfigSchema } from './config';
import { addressBookSyncMessages } from './messages';

export const addressBookSyncManifest: PluginManifest = {
  pluginId: 'official.address-book-sync',
  kind: 'managed_group',
  version: '0.2.0',
  coreApiRange: '>=0.2.0',
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
  eventSubscriptions: ['participant.change'],
  requiredPermissions: ['plugin.configure'],
  requiredBotCapabilities: [],
  configSchema: addressBookSyncConfigSchema,
  dangerousActions: ['contact.saveToAddressBook'],
  backgroundJobs: [],
  cancellation: { workflows: [] },
  assistant: {
    summary: 'Automatically saves unknown arriving members using push name, username, or phone number and supports explicit backfill and repair.',
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
      'Automatic saves only consider participant-change events; current participants require an explicit backfill action.',
      'WhatsApp clients may not reflect app-state contact saves uniformly across devices.'
    ]
  }
};
