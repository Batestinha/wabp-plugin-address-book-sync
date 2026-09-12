const { test } = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../dist/index.js').default;
const { planAddressBookSync, selectAddressBookContactName } = require('../dist/sync.js');
const { parseAddressBookSyncConfig } = require('../dist/config.js');

function fixture() {
  const seen = new Map();
  const identity = { identityId: 'fixture-person', sourceWid: 'fixture@lid', deliveryChatId: 'fixture@lid', canonicalWid: 'fixture@lid', mentionWid: 'fixture@lid', addressBookWid: '351900000001@c.us' };
  const resolution = { ...identity, originalWid: identity.addressBookWid, phoneNumber: '351900000001', phoneWids: [identity.addressBookWid], lidWids: [identity.canonicalWid], aliases: [identity.addressBookWid, identity.canonicalWid], dedupeKey: identity.identityId };
  const runtime = {
    ephemeralStore: { get: async key => seen.get(key), set: async (key, value) => { seen.set(key, value); }, setIfAbsent: async (key, value) => { if (seen.has(key)) return false; seen.set(key, value); return true; }, increment: async key => { const count = (seen.get(key) ?? 0) + 1; seen.set(key, count); return count; } },
    isKnownContact: async () => false,
    getUserProfileNames: async () => [{ wid: identity.addressBookWid, pushName: 'Fixture Person', username: 'fallback' }],
    resolveIdentityAddress: async () => resolution
  };
  return { identity, runtime, input: { runtime, target: { scopeId: 'fixture-scope', chatId: 'fixture@g.us', eventId: 'fixture-event' }, config: parseAddressBookSyncConfig({ enabled: true, suffix: '(Preserved)' }), targetIdentities: [identity], includeSkipAuditActions: true } };
}

test('keeps configured suffixes and deduplicates aliases and repeated deliveries', async () => {
  const { identity, input } = fixture();
  input.targetIdentities.push({ ...identity, sourceWid: identity.addressBookWid });
  const first = await planAddressBookSync(input);
  const saves = first.actions.filter(action => action.type === 'contact.saveToAddressBook');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].wid, identity.addressBookWid);
  assert.equal(saves[0].contactName, 'Fixture Person (Preserved)');
  const retry = await planAddressBookSync(input);
  assert.equal(retry.actions.filter(action => action.type === 'contact.saveToAddressBook').length, 0);
  assert.equal(retry.results[0].reason, 'duplicate-event');
});

test('excludes the bot and known contacts using authoritative stable identity values', async () => {
  const { identity, input } = fixture();
  input.botIdentityIds = [identity.identityId];
  assert.equal((await planAddressBookSync(input)).results[0].reason, 'self-recipient');
  input.botIdentityIds = [];
  input.runtime.isKnownContact = async () => true;
  assert.equal((await planAddressBookSync(input)).results[0].reason, 'known-contact');
});

test('uses scoped actor configuration and remains inactive when its stored enabled setting is false', async () => {
  const scopes = [];
  const hooks = plugin.registerHooks({ configFor: async (...args) => { scopes.push(args); return { enabled: false, suffix: '(Kept)' }; } });
  assert.equal(await hooks.onParticipantChange({ scopeId: 'owned-scope', actorIdentity: { identityId: 'actor' } }), undefined);
  assert.deepEqual(scopes, [['owned-scope', 'actor']]);
});

test('preserves name selection priority without using unverified display labels', () => {
  assert.deepEqual(selectAddressBookContactName({ pushName: ' First ', username: 'second' }, '351900000001'), { value: 'First', source: 'push-name' });
  assert.deepEqual(selectAddressBookContactName({ username: '@second' }, '351900000001'), { value: '@second', source: 'username' });
  assert.deepEqual(selectAddressBookContactName({}, '351900000001'), { value: '+351900000001', source: 'phone-number' });
  assert.equal(selectAddressBookContactName({}, undefined), undefined);
});
