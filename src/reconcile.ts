import type { PluginHookContext, PluginCoveredGroup } from '@wabs/plugin-sdk/hook-plugin';
import type { StableIdentityAddressResolution } from '@wabs/plugin-sdk/identity';
import type { WhatsAppUserProfileNames } from '@wabs/plugin-sdk/transport';
import { parseAddressBookSyncConfig } from './config';
import { ADDRESS_BOOK_SYNC_PLUGIN_ID, appendAddressBookSuffix, selectAddressBookContactName } from './sync';
import { historicalAddressBookContactSaveAuditSchema, historicalPhoneFallbackSuffix, normalizeAddressBookWid } from './repair';

export const SCAN_JOB = 'contact-sync.reconcile';
export const RETRY_JOB = 'contact-sync.retry';
export const SCAN_INTERVAL_MS = 15 * 60_000;
const RETRY_DELAYS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
const PREFIX = 'contact-sync:pending:';
export interface PendingContact {
  identityId: string; wid: string; groupWid: string; attempts: number; nextAttemptAt: number;
  status: 'pending-name' | 'retry-scheduled' | 'saving';
  intendedName?: string; expectedName?: string | null; error?: string;
}
export interface ReconcileInput {
  scopeId: string; chatId?: string | undefined; participantWids?: string[] | undefined;
  mode?: 'sync-members' | 'unknown-members' | 'repair-phone-fallbacks' | undefined;
  dryRun?: boolean | undefined; automatic?: boolean | undefined; allowNew?: boolean | undefined;
  force?: boolean | undefined; signal?: AbortSignal | undefined;
}
export interface ContactResult {
  identityId: string; wid: string; chatId: string;
  status: 'saved' | 'repaired' | 'would_save' | 'would_repair' | 'pending-name' | 'retry-scheduled' | 'skipped' | 'failed';
  reason?: string; contactName?: string; nameSource?: string; error?: string;
}

export function createContactReconciler(context: PluginHookContext, now = Date.now) {
  function runtime() {
    const { contacts, dataStore, resolveIdentityAddress, getGroupParticipants, coveredGroupsForScope, enqueuePluginJob, getUserProfileNames } = context;
    if (!contacts || !dataStore || !resolveIdentityAddress || !getGroupParticipants || !coveredGroupsForScope || !enqueuePluginJob || !getUserProfileNames) {
      throw new Error('Address Book Sync requires the host contact reconciliation capabilities (core API 0.3.11).');
    }
    return { contacts, dataStore, resolve: resolveIdentityAddress, getGroupParticipants, coveredGroupsForScope, enqueuePluginJob, getUserProfileNames };
  }
  async function scheduleScan(scopeId: string, at = now()) {
    await runtime().enqueuePluginJob({ jobName: SCAN_JOB, scopeId, executionClass: 'maintenance', runAt: new Date(at), payload: {},
      dedupeKey: `contact-sync:scan:${scopeId}:${Math.floor(at / SCAN_INTERVAL_MS)}`, replaceRetainedTerminalJob: true });
  }
  async function schedulePending(scopeId: string, pending: PendingContact) {
    await runtime().enqueuePluginJob({ jobName: RETRY_JOB, scopeId, ...(pending.groupWid ? { groupWid: pending.groupWid } : {}), executionClass: 'maintenance',
      runAt: new Date(pending.nextAttemptAt), payload: { identityId: pending.identityId },
      dedupeKey: `contact-sync:retry:${scopeId}:${pending.identityId}:${pending.nextAttemptAt}`, replaceRetainedTerminalJob: true });
  }
  async function withIdentityLease<T>(scopeId: string, identityId: string, run: () => Promise<T>) {
    const key = `contact-sync:working:${scopeId}:${identityId}`;
    const lease = `${now()}:${Math.random()}`;
    if (!await context.ephemeralStore.setIfAbsent(key, lease, 300_000)) return;
    try { return await run(); }
    finally { if (await context.ephemeralStore.get(key) === lease) await context.ephemeralStore.delete(key); }
  }
  async function ready() {
    const rt = runtime();
    const scopes = await context.listEnabledScopes?.() ?? [];
    const enabled = new Set(scopes.map(scope => scope.scopeId));
    for (const scope of scopes) await scheduleScan(scope.scopeId);
    for (const row of await rt.dataStore.list()) {
      if (!row.scopeId || !enabled.has(row.scopeId) || !row.key.startsWith(PREFIX)) continue;
      const pending = row.valueJson as PendingContact;
      if (pending?.identityId && Number.isFinite(pending.nextAttemptAt)) await schedulePending(row.scopeId, pending);
    }
  }
  async function run(input: ReconcileInput) {
    const rt = runtime();
    input.signal?.throwIfAborted();
    const config = parseAddressBookSyncConfig(await context.configFor(input.scopeId));
    const results: ContactResult[] = [];
    const groupErrors: Array<{ chatId: string; error: string }> = [];
    if (!config.enabled || !await context.enabledFor(input.scopeId)) return summarize(results, input, 0, groupErrors, 'plugin-disabled');
    const groups = (await rt.coveredGroupsForScope(input.scopeId))
      .filter(group => !input.chatId || group.groupWid === input.chatId);
    if (input.chatId && !groups.length) throw new Error('Group is not covered by the selected scope.');
    const resolveCache = new Map<string, Promise<StableIdentityAddressResolution>>();
    const resolve = (wid: string) => {
      if (!resolveCache.has(wid)) resolveCache.set(wid, rt.resolve(wid));
      return resolveCache.get(wid)!;
    };
    const botWid = await context.getCurrentBotWid?.();
    const botId = botWid ? (await resolve(botWid)).identityId : undefined;
    const selected = input.participantWids?.length
      ? new Set((await Promise.all(input.participantWids.map(resolve))).map(identity => identity.identityId)) : undefined;
    // The arrival job is already durable. Retain its eligible identities before
    // any membership/profile request, including when only some triggers are on.
    if (!input.dryRun && input.automatic && input.allowNew) {
      for (const wid of input.participantWids ?? []) {
        const identity = await resolve(wid);
        if (identity.identityId === botId) continue;
        await withIdentityLease(input.scopeId, identity.identityId, async () => {
          const key = PREFIX + identity.identityId;
          if (await rt.dataStore.get(key, input.scopeId)) return;
          const pending: PendingContact = { identityId: identity.identityId, wid: identity.addressBookWid,
            groupWid: input.chatId ?? '', attempts: 0, nextAttemptAt: now() + RETRY_DELAYS[0]!, status: 'pending-name' };
          await rt.dataStore.set(key, pending, input.scopeId);
          await schedulePending(input.scopeId, pending);
        });
      }
    }
    const members = new Map<string, { identity: StableIdentityAddressResolution; group: PluginCoveredGroup }>();
    const successfulGroups = new Set<string>();
    for (const group of groups) {
      input.signal?.throwIfAborted();
      if (group.managementMode !== 'MANAGE' || config.exemptGroupChatIds.includes(group.groupWid)) continue;
      try {
        const participants = await rt.getGroupParticipants(group.groupWid);
        for (const participant of participants) {
          const identity = await resolve(participant.wid);
          if (identity.identityId === botId || (selected && !selected.has(identity.identityId))) continue;
          if (!members.has(identity.identityId)) members.set(identity.identityId, { identity, group });
        }
        successfulGroups.add(group.groupWid);
      } catch (error) { groupErrors.push({ chatId: group.groupWid, error: errorMessage(error) }); }
    }
    const identities = [...members.values()].map(member => member.identity);
    const snapshots = [];
    for (let offset = 0; offset < identities.length; offset += 512) {
      snapshots.push(...await rt.contacts.inspect(input.scopeId, identities.slice(offset, offset + 512).map(identity => identity.addressBookWid)));
    }
    const currentNames = new Map(snapshots.map(contact => [contact.identityId, contact.contactName]));
    const fallbacks = new Map<string, { oldName: string; suffix: string }>();
    if (input.mode !== 'unknown-members') {
      for (const row of await rt.contacts.readSaveReceipts(input.scopeId)) {
        const parsed = historicalAddressBookContactSaveAuditSchema.safeParse(row.targetJson);
        if (!parsed.success) continue;
        const action = parsed.data.action;
        const identity = await resolve(action.wid);
        if (!members.has(identity.identityId) || fallbacks.has(identity.identityId)) continue;
        const oldName = (action.contactName ?? action.displayName)!;
        const suffix = historicalPhoneFallbackSuffix(oldName, identity.addressBookWid);
        if (suffix !== undefined && currentNames.get(identity.identityId) === oldName) {
          fallbacks.set(identity.identityId, { oldName, suffix });
        }
      }
    }
    const candidates = [];
    for (const member of members.values()) {
      const { identity, group } = member;
      const pending = await rt.dataStore.get<PendingContact>(PREFIX + identity.identityId, input.scopeId);
      const current = currentNames.get(identity.identityId);
      const fallback = fallbacks.get(identity.identityId);
      const base = { identityId: identity.identityId, wid: identity.addressBookWid, chatId: group.groupWid };
      if (pending?.intendedName && current === pending.intendedName) {
        if (!input.dryRun) await withIdentityLease(input.scopeId, identity.identityId, () => rt.dataStore.delete(PREFIX + identity.identityId, input.scopeId));
        results.push({ ...base, status: input.dryRun ? 'skipped' : pending.expectedName ? 'repaired' : 'saved', contactName: current });
      } else if (current && !fallback || !current && input.mode === 'repair-phone-fallbacks') {
        if (!input.dryRun && pending) await withIdentityLease(input.scopeId, identity.identityId, () => rt.dataStore.delete(PREFIX + identity.identityId, input.scopeId));
        results.push({ ...base, status: 'skipped', reason: current ? 'known-contact' : 'contact-not-found' });
      } else if (input.automatic && !fallback && !pending && !input.allowNew
        && !(config.saveOnJoin && config.saveOnAdd && config.saveOnApproval)) {
        results.push({ ...base, status: 'skipped', reason: 'arrival-trigger-required' });
      } else if (input.automatic && pending && !input.force && !input.allowNew && pending.nextAttemptAt > now()) {
        results.push({ ...base, status: pending.status === 'pending-name' ? 'pending-name' : 'retry-scheduled' });
      } else candidates.push({ ...member, pending, fallback, base });
    }
    const profiles: WhatsAppUserProfileNames[] = [];
    let profileError: string | undefined;
    for (let offset = 0; offset < candidates.length; offset += 512) {
      try { profiles.push(...await rt.getUserProfileNames(candidates.slice(offset, offset + 512).map(candidate => candidate.identity.addressBookWid))); }
      catch (error) { profileError = errorMessage(error); }
    }
    const byWid = new Map(profiles.map(profile => [normalizeAddressBookWid(profile.wid), profile]));
    for (const candidate of candidates) {
      input.signal?.throwIfAborted();
      const { identity, group, fallback, base } = candidate;
      const selectedName = selectAddressBookContactName(byWid.get(normalizeAddressBookWid(identity.addressBookWid)), identity.displayName);
      const contactName = selectedName ? appendAddressBookSuffix(selectedName.value, fallback?.suffix ?? config.suffix) : undefined;
      if (input.dryRun) {
        results.push({ ...base, status: contactName ? (fallback ? 'would_repair' : 'would_save') : 'pending-name',
          ...(contactName ? { contactName, nameSource: selectedName!.source } : {}) });
        continue;
      }
      const processed = await withIdentityLease(input.scopeId, identity.identityId, async () => {
        const pending = await rt.dataStore.get<PendingContact>(PREFIX + identity.identityId, input.scopeId);
        // Persist before mutation, so a crash or ambiguous response can be reconciled.
        const work: PendingContact = { identityId: identity.identityId, wid: identity.addressBookWid, groupWid: group.groupWid,
          attempts: (pending?.attempts ?? 0) + 1, nextAttemptAt: now() + RETRY_DELAYS[Math.min(pending?.attempts ?? 0, RETRY_DELAYS.length - 1)]!,
          status: contactName ? 'saving' : 'pending-name', ...(contactName ? { intendedName: contactName, expectedName: fallback?.oldName ?? null } : {}) };
        await rt.dataStore.set(PREFIX + identity.identityId, work, input.scopeId);
        if (!contactName) {
          if (profileError) {
            work.status = 'retry-scheduled'; work.error = profileError;
            await rt.dataStore.set(PREFIX + identity.identityId, work, input.scopeId);
          }
          await schedulePending(input.scopeId, work);
          results.push({ ...base, status: profileError ? 'retry-scheduled' : 'pending-name', ...(profileError ? { error: profileError } : {}) }); return true;
        }
        try {
          const latest = parseAddressBookSyncConfig(await context.configFor(input.scopeId));
          if (!latest.enabled || latest.exemptGroupChatIds.includes(group.groupWid)) {
            await rt.dataStore.delete(PREFIX + identity.identityId, input.scopeId);
            results.push({ ...base, status: 'skipped', reason: 'configuration-changed' }); return true;
          }
          const saved = await rt.contacts.save({ scopeId: input.scopeId, groupWid: group.groupWid, wid: identity.addressBookWid,
            contactName, expectedName: fallback?.oldName ?? null, reason: fallback ? `${ADDRESS_BOOK_SYNC_PLUGIN_ID}.repair-phone-fallback` : ADDRESS_BOOK_SYNC_PLUGIN_ID });
          await rt.dataStore.delete(PREFIX + identity.identityId, input.scopeId);
          results.push({ ...base, status: saved.status === 'precondition-failed' ? 'skipped' : fallback ? 'repaired' : 'saved',
            ...(saved.status === 'precondition-failed' ? { reason: 'contact-name-changed' } : { contactName, nameSource: selectedName!.source }) });
        } catch (error) {
          work.status = 'retry-scheduled'; work.error = errorMessage(error);
          await rt.dataStore.set(PREFIX + identity.identityId, work, input.scopeId);
          await schedulePending(input.scopeId, work);
          results.push({ ...base, status: 'retry-scheduled', error: work.error });
        }
        return true;
      });
      if (!processed) results.push({ ...base, status: 'skipped', reason: 'in-progress' });
    }
    // A failed group read is not evidence of departure. Prune only after a complete scan.
    if (!input.dryRun && !input.chatId && !selected && groupErrors.length === 0) {
      for (const row of await rt.dataStore.list()) {
        if (row.scopeId !== input.scopeId || !row.key.startsWith(PREFIX)) continue;
        const work = row.valueJson as PendingContact;
        if (!members.has(work.identityId)) await withIdentityLease(input.scopeId, work.identityId, () => rt.dataStore.delete(row.key, input.scopeId));
      }
    }
    return summarize(results, input, successfulGroups.size, groupErrors);
  }
  async function retry(scopeId: string, identityId: string) {
    const work = await runtime().dataStore.get<PendingContact>(PREFIX + identityId, scopeId);
    if (!work || work.nextAttemptAt > now()) return;
    // Search all currently covered groups: the originating event group may have closed.
    return run({ scopeId, participantWids: [work.wid], automatic: true });
  }
  return { run, ready, retry, scheduleScan };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function summarize(results: ContactResult[], input: ReconcileInput, groupCount: number,
  groupErrors: Array<{ chatId: string; error: string }>, reason?: string) {
  const count = (status: ContactResult['status']) => results.filter(result => result.status === status).length;
  return { pluginId: ADDRESS_BOOK_SYNC_PLUGIN_ID, scopeId: input.scopeId, mode: input.mode ?? 'sync-members', dryRun: input.dryRun ?? false,
    groupCount, scanned: results.length, saved: count('saved'), repaired: count('repaired'), pendingNames: count('pending-name'),
    retryScheduled: count('retry-scheduled'), failed: count('failed') + groupErrors.length, skipped: count('skipped'),
    wouldSave: count('would_save'), wouldRepair: count('would_repair'), saveRequests: count('saved'), repairRequests: count('repaired'),
    ...(reason ? { reason } : {}), groupErrors, results: results.slice(0, 200), resultLimit: 200, resultsTruncated: results.length > 200 };
}
