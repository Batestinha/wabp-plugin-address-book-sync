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
