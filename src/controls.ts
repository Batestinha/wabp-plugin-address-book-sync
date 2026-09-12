import { defineControl } from '../../../../packages/plugin-sdk/src/controls';
import type { ControlDescriptor, ControlSchemaMetadata, ControlUiHint } from '../../../../packages/plugin-sdk/src/controls-types';
import { DEFAULT_ADDRESS_BOOK_SYNC_SUFFIX } from './config';

const ADDRESS_BOOK_SYNC_BACKFILL_ACTION_ID = 'official.address-book-sync.backfill';

function control(
  path: string,
  label: string,
  description: string,
  order: number,
  schema: ControlSchemaMetadata,
  ui: ControlUiHint,
  defaultValue?: unknown
): ControlDescriptor {
  return defineControl({
    id: `plugin.official.address-book-sync.${path}`,
    label,
    description,
    plane: 'plugin-scope-config',
    domain: 'official-plugin-settings',
    section: 'Address Book Sync',
    order,
    visibility: 'bot_admin',
    configurable: true,
    storage: { kind: 'plugin-scope-config', pluginId: 'official.address-book-sync', path },
    schema,
    ui: { helpText: description, ...ui },
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    restartRequirement: 'NO_RESTART',
    dangerous: false,
    sensitivity: { sensitive: false, redact: 'none' },
    auditAction: 'operator_console.plugin_config.update',
    relatedCommandIds: [],
    relatedActionIds: [ADDRESS_BOOK_SYNC_BACKFILL_ACTION_ID]
  });
}

export const addressBookSyncControls: ControlDescriptor[] = [
  control('enabled', 'Enabled', 'Save unknown arriving group members to the WhatsApp address book.', 10, { type: 'boolean' }, { widget: 'toggle' }, false),
  control('saveOnJoin', 'Direct joins', 'Save contacts when WhatsApp reports a direct join.', 20, { type: 'boolean' }, { widget: 'toggle' }, true),
  control('saveOnAdd', 'Admin-added members', 'Save contacts when a member is added by an admin.', 30, { type: 'boolean' }, { widget: 'toggle' }, true),
  control('saveOnApproval', 'Approved requests', 'Save contacts after an admin approves a membership request.', 40, { type: 'boolean' }, { widget: 'toggle' }, true),
  control('suffix', 'Name suffix', 'Suffix appended to saved contact names.', 50, { type: 'string' }, { widget: 'text' }, DEFAULT_ADDRESS_BOOK_SYNC_SUFFIX),
  control('exemptGroupChatIds', 'Exempt groups', 'Managed groups in this scope that should not save arriving members.', 60, { type: 'array', items: { type: 'string' } }, { widget: 'tags' }, []),
  control(
    'dedupeTtlSeconds',
    'Dedupe TTL',
    'Seconds to suppress duplicate address-book saves for the same scope, group, and user.',
    70,
    { type: 'number', unit: 'seconds', min: 1, max: 2_592_000 },
    { widget: 'duration' },
    86_400
  )
];
