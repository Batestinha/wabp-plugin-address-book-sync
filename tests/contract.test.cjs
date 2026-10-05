const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validatePluginManifest } = require('@wabs/plugin-sdk/manifest');
const plugin = require('../dist/index.js').default;
const metadata = require('../wa-plugin.json');

test('retains the stable plugin identity, declared actions, configuration and translation keys', () => {
  assert.equal(validatePluginManifest(plugin.manifest), plugin.manifest);
  for (const key of ['pluginId', 'version', 'coreApiRange', 'messageNamespace', 'commands', 'eventSubscriptions', 'dangerousActions', 'backgroundJobs']) {
    assert.deepEqual(plugin.manifest[key], metadata[key], key);
  }
  const pt = JSON.parse(fs.readFileSync(path.join(__dirname, '../locales/pt-PT', metadata.messageNamespace + '.json')));
  for (const key of Object.keys(plugin.manifest.defaultMessages)) {
    assert.equal(typeof pt[key], 'string', key);
    assert.ok(pt[key].trim(), key);
  }
  assert.equal(typeof plugin.registerHooks, 'function');
  assert.equal(plugin.lifecycle, undefined);
});

// Package metadata is consumed before the executable manifest is loaded.
test('console config metadata covers each stored field with a control or an explained internal path', () => {
  const console = metadata.operatorConsole;
  for (const internal of console.internalConfigPaths) {
    assert.equal(typeof internal.path, 'string');
    assert.equal(typeof internal.reason, 'string');
    assert.ok(internal.reason.length);
  }
  const covered = [...console.controls, ...console.internalConfigPaths].map(entry => entry.path);
  assert.deepEqual([...new Set(covered)].sort(), [...console.configPaths].sort());
});
