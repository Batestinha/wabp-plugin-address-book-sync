import type { BotPlugin } from '../../../platform/pluginRuntime/types';
import { createAddressBookSyncHooks } from './hooks';
import { addressBookSyncManifest } from './manifest';

export const addressBookSyncPlugin: BotPlugin = {
  manifest: addressBookSyncManifest,
  registerHooks: createAddressBookSyncHooks
};

export default addressBookSyncPlugin;
