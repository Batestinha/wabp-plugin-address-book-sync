const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createContactReconciler, RETRY_JOB } = require('../dist/reconcile');
const { historicalAddressBookContactSaveAuditSchema } = require('../dist/repair');
const plugin = require('../dist').default;

function harness() {
  let time = 1_000_000;
  const rows = new Map(), locks = new Map(), jobs = [], writes = [];
  const wid = '351900000001@c.us', lid = '100000000001@lid';
  const identity = { identityId: 'person', originalWid: wid, canonicalWid: wid, addressBookWid: wid,
    sourceWid: lid, deliveryChatId: lid, mentionWid: lid, phoneNumber: '351900000001',
    phoneWids: [wid], lidWids: [lid], aliases: [wid, lid, '351900000001@s.whatsapp.net'], dedupeKey: 'person' };
  const state = { name: undefined, pushName: undefined, identityName: undefined, config: { enabled: true, suffix: '(Escalada)' },
    members: [{ wid: lid }], receipts: [], fail: false, failProfiles: false, enabled: true, groups: [{ scopeId: 'scope', groupId: 'group', groupWid: 'group@g.us', managementMode: 'MANAGE' }] };
  const context = { pluginId: 'official.address-book-sync', manifest: plugin.manifest,
    configFor: async () => state.config, enabledFor: async () => state.enabled,
    listEnabledScopes: async () => [{ scopeId: 'scope' }], coveredGroupsForScope: async () => state.groups,
    getCurrentBotWid: async () => undefined, getGroupParticipants: async () => state.members,
    resolveIdentityAddress: async value => ({ ...identity, originalWid: value, displayName: state.identityName }),
    getUserProfileNames: async () => { if (state.failProfiles) throw Error('429'); return [{ wid, pushName: state.pushName }]; },
    dataStore: { get: async (key, scope) => rows.get(scope + ':' + key),
      set: async (key, value, scope) => { rows.set(scope + ':' + key, structuredClone(value)); },
      delete: async (key, scope) => Number(rows.delete(scope + ':' + key)),
      list: async () => [...rows].map(([key, valueJson]) => ({ id: key, scopeId: key.split(':')[0], key: key.slice(key.indexOf(':') + 1), valueJson })) },
    ephemeralStore: { setIfAbsent: async (key, value) => { if (locks.has(key)) return false; locks.set(key, value); return true; },
      get: async key => locks.get(key), delete: async key => Number(locks.delete(key)) },
    enqueuePluginJob: async job => jobs.push(job),
    contacts: { inspect: async () => [{ identityId: 'person', wid, contactName: state.name }], readSaveReceipts: async () => state.receipts,
      save: async input => { writes.push(input); if (state.fail) throw Error('app-state conflict');
        if ((state.name ?? null) !== input.expectedName) return { status: state.name === input.contactName ? 'unchanged' : 'precondition-failed' };
        state.name = input.contactName; return { status: 'saved', contactName: state.name }; } }
  };
  const reconciler = createContactReconciler(context, () => time);
  const run = input => reconciler.run({ scopeId: 'scope', ...input });
  const receipt = (field = 'contactName') => ({ id: 'save', groupId: 'old-group', targetJson: { pluginId: context.pluginId,
    actionType: 'contact.saveToAddressBook', action: { type: 'contact.saveToAddressBook', wid, [field]: '+351900000001 (Escalada)', sourceGroupWid: 'old@g.us' } } });
  return { state, context, rows, locks, jobs, writes, reconciler, run, receipt, wid, lid, advance: ms => { time += ms; } };
}

test('current contactName receipt repairs to the learned display name with historical suffix', async () => {
  const h = harness(); h.state.name = '+351900000001 (Escalada)'; h.state.pushName = 'Fixture Person';
  h.state.receipts = [h.receipt()]; h.state.config.suffix = '(New suffix)';
  assert.equal(historicalAddressBookContactSaveAuditSchema.safeParse(h.state.receipts[0].targetJson).success, true);
  const preview = await h.run({ dryRun: true });
  assert.equal(preview.wouldRepair, 1); assert.equal(h.writes.length, 0); assert.equal(h.rows.size, 0); assert.equal(h.jobs.length, 0);
  const result = await h.run(); assert.equal(result.repaired, 1); assert.equal(h.state.name, 'Fixture Person (Escalada)');
  assert.equal(h.writes[0].expectedName, '+351900000001 (Escalada)');
  assert.equal((await h.run()).repaired, 0); assert.equal(h.writes.length, 1);
});

test('legacy receipts work and manual contact edits are preserved', async () => {
  const h = harness(); h.state.receipts = [h.receipt('displayName')]; h.state.name = 'My friend'; h.state.pushName = 'Fixture Person';
  assert.equal((await h.run()).skipped, 1); assert.equal(h.writes.length, 0);
  h.state.name = '+351900000001 (Escalada)'; assert.equal((await h.run()).repaired, 1);
});

test('waits without saving a phone fallback and resumes after the name arrives', async () => {
  const h = harness(); const first = await h.run();
  assert.equal(first.pendingNames, 1); assert.equal(h.writes.length, 0); assert.equal(h.rows.size, 1);
  assert.equal(h.jobs[0].runAt.getTime(), 1_060_000);
  h.state.pushName = 'Fixture Person'; h.advance(60_000);
  const result = await h.reconciler.retry('scope', 'person');
  assert.equal(result.saved, 1); assert.equal(h.state.name, 'Fixture Person (Escalada)'); assert.equal(h.rows.size, 0);
});

test('uses persisted identity display names and refuses phone labels as identity names', async () => {
  const h = harness(); h.state.identityName = '+351900000001 (Escalada)';
  assert.equal((await h.run()).pendingNames, 1); h.state.identityName = 'Fixture Person';
  assert.equal((await h.run()).saved, 1); assert.equal(h.state.name, 'Fixture Person (Escalada)');
});

test('failed saves remain retryable without the old 24-hour duplicate suppression', async () => {
  const h = harness(); h.state.pushName = 'Fixture Person'; h.state.fail = true;
  const first = await h.run(); assert.equal(first.saved, 0); assert.equal(first.retryScheduled, 1); assert.equal(h.rows.size, 1);
  h.state.fail = false; h.advance(60_000); assert.equal((await h.reconciler.retry('scope', 'person')).saved, 1);
  assert.equal(h.writes.length, 2); assert.equal(h.locks.size, 0);
});

test('an acknowledged write followed by a crash is confirmed without another write', async () => {
  const h = harness(); h.state.pushName = 'Fixture Person'; h.state.fail = true; await h.run();
  h.state.name = 'Fixture Person (Escalada)'; h.advance(60_000);
  assert.equal((await h.reconciler.retry('scope', 'person')).saved, 1); assert.equal(h.writes.length, 1); assert.equal(h.rows.size, 0);
});

test('restart restores pending jobs and stale jobs cannot recreate saved work', async () => {
  const h = harness(); await h.run(); h.jobs.length = 0; await createContactReconciler(h.context).ready();
  assert.equal(h.jobs.some(job => job.jobName === RETRY_JOB), true);
  h.state.pushName = 'Fixture Person'; await h.run();
  assert.equal(await h.reconciler.retry('scope', 'person'), undefined);
});

test('does not confuse failed group reads with departures; removes departed pending work', async () => {
  const h = harness(); await h.run();
  h.context.getGroupParticipants = async () => { throw Error('offline'); };
  assert.equal((await h.run()).failed, 1); assert.equal(h.rows.size, 1);
  h.context.getGroupParticipants = async () => []; await h.run(); assert.equal(h.rows.size, 0);
});

test('rate-limited name lookups retain pending work and use backoff', async () => {
  const h = harness(); h.state.failProfiles = true;
  const result = await h.run(); assert.equal(result.retryScheduled, 1); assert.equal(h.rows.size, 1); assert.equal(h.writes.length, 0);
  h.advance(60_000); await h.reconciler.retry('scope', 'person');
  assert.equal(h.jobs.at(-1).runAt.getTime(), 1_360_000);
});

test('scope exclusions and management mode prevent writes; manual selection cannot add nonmembers', async () => {
  const h = harness(); h.state.pushName = 'Fixture Person'; h.state.config.exemptGroupChatIds = ['group@g.us'];
  await assert.rejects(h.run({ chatId: 'foreign@g.us' }), { statusCode: 409 });
  await h.run(); assert.equal(h.writes.length, 0);
  h.state.config.exemptGroupChatIds = []; h.state.groups[0].managementMode = 'OBSERVE'; await h.run(); assert.equal(h.writes.length, 0);
  h.state.groups[0].managementMode = 'MANAGE'; h.state.enabled = false; await h.run(); assert.equal(h.writes.length, 0);
  h.state.enabled = true; h.state.members = []; await h.run({ participantWids: [h.wid] }); assert.equal(h.writes.length, 0);
});

test('an eligible arrival survives the first membership lookup failing with partial triggers', async () => {
  const h = harness(); h.state.config.saveOnAdd = false;
  h.context.getGroupParticipants = async () => { throw Error('offline'); };
  assert.equal((await h.run({ automatic: true, allowNew: true, participantWids: [h.wid] })).failed, 1);
  assert.equal(h.rows.size, 1); assert.equal(h.jobs.some(job => job.jobName === RETRY_JOB), true);
  h.context.getGroupParticipants = async () => h.state.members; h.state.pushName = 'Fixture Person'; h.advance(60_000);
  assert.equal((await h.reconciler.retry('scope', 'person')).saved, 1);
});

test('aliases, repeated membership across groups, and concurrent scans save once', async () => {
  const h = harness(); h.state.pushName = 'Fixture Person';
  h.state.members.push({ wid: h.wid }); h.state.groups.push({ ...h.state.groups[0], groupWid: 'second@g.us' });
  await Promise.all([h.run(), h.run()]); assert.equal(h.writes.length, 1); assert.equal(h.state.name, 'Fixture Person (Escalada)');
});

test('configuration changes and operator edits between planning and writing win', async () => {
  const h = harness(); h.state.pushName = 'Fixture Person';
  const save = h.context.contacts.save; h.context.contacts.save = async input => { h.state.name = 'Manually saved'; return save(input); };
  assert.equal((await h.run()).skipped, 1); assert.equal(h.state.name, 'Manually saved'); assert.equal(h.rows.size, 0);
});

test('preview preserves pending state and never schedules work', async () => {
  const h = harness(); await h.run(); const before = JSON.stringify([...h.rows]); const jobs = h.jobs.length;
  h.state.pushName = 'Fixture Person'; await h.run({ dryRun: true });
  assert.equal(JSON.stringify([...h.rows]), before); assert.equal(h.jobs.length, jobs); assert.equal(h.writes.length, 0);
});

test('disabled arrival types cannot create work through catch-up with partial trigger settings', async () => {
  const h = harness(); h.state.pushName = 'Fixture Person'; h.state.config.saveOnJoin = false;
  assert.equal((await h.run({ automatic: true })).skipped, 1); assert.equal(h.writes.length, 0);
  assert.equal((await h.run({ automatic: true, allowNew: true })).saved, 1);
});

test('arrival hooks enqueue durable work and message hooks wake the named identity', async () => {
  const h = harness(), hooks = plugin.registerHooks(h.context);
  await hooks.onParticipantChange({ scopeId: 'scope', chatId: 'group@g.us', action: 'join', eventId: 'join1', botIdentityIds: [],
    affectedIdentities: [{ identityId: 'person', addressBookWid: h.wid }] });
  assert.equal(h.jobs[0].jobName, RETRY_JOB); assert.deepEqual(h.jobs[0].payload.wids, [h.wid]); assert.equal(h.writes.length, 0);
  await hooks.onMessage({ scopeId: 'scope', actorWid: h.lid, actorIdentityId: 'person', message: { context: 'group', chatId: 'group@g.us', fromMe: false } });
  assert.equal(h.jobs[1].payload.wake, true);
});
