import type { HookPlugin as BotPlugin } from '@wabs/plugin-sdk/hook-plugin';
import { createAddressBookSyncHooks } from './hooks';
import { addressBookSyncManifest } from './manifest';

export const addressBookSyncPlugin: BotPlugin = {
  manifest: addressBookSyncManifest,
  registerHooks: createAddressBookSyncHooks
};

export default addressBookSyncPlugin;
