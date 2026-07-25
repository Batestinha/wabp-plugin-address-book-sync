import type { PluginManifest } from '../../../platform/pluginRuntime/manifest';
import { addressBookSyncConfigSchema } from './config';
import { addressBookSyncMessages } from './messages';

export const addressBookSyncManifest: PluginManifest = {
  pluginId: 'official.address-book-sync',
  kind: 'managed_group',
  version: '0.1.0',
  coreApiRange: '>=0.2.0',
  messageNamespace: 'official.address-book-sync',
  descriptionKey: 'official.address-book-sync.description',
  defaultMessages: addressBookSyncMessages,
  commands: [],
  eventSubscriptions: ['participant.change'],
  requiredPermissions: ['plugin.configure'],
  requiredBotCapabilities: [],
  configSchema: addressBookSyncConfigSchema,
  dangerousActions: ['contact.saveToAddressBook'],
  backgroundJobs: [],
  cancellation: { workflows: [] },
  assistant: {
    summary: 'Automatically saves unknown arriving members to the WhatsApp address book and supports explicit backfill for current group participants.',
    useCases: [
      'Explain whether unknown joining members will be saved to the address book.',
      'Summarize the configured suffix and event triggers.',
      'Backfill unknown current group participants after enabling the plugin.',
      'Describe duplicate suppression for repeated participant-change events.'
    ],
    prerequisites: [
      'The plugin must be enabled in the target managed scope.',
      'The active transport must support WhatsApp address-book contact saves.',
      'The runtime must provide live group participant and contact lookup helpers.'
    ],
    limitations: [
      'Automatic saves only consider participant-change events; current participants require an explicit backfill action.',
      'WhatsApp clients may not reflect app-state contact saves uniformly across devices.'
    ]
  }
};
