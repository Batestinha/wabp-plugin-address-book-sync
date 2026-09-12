const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'wa-plugin.json')));
const plugin = require(path.join(root, manifest.entrypoint)).default;
assert.equal(plugin.manifest.pluginId, manifest.pluginId);
assert.equal(plugin.manifest.version, manifest.version);
assert.equal(plugin.manifest.coreApiRange, '^0.3.0');
assert.equal(typeof plugin.registerHooks, 'function');
assert.equal(plugin.lifecycle, undefined);
const pt = JSON.parse(fs.readFileSync(path.join(root, 'locales/pt-PT', manifest.messageNamespace + '.json')));
for (const key of Object.keys(plugin.manifest.defaultMessages)) assert.ok(pt[key]?.trim(), key);
assert.ok(fs.existsSync(path.join(root, 'node_modules/@wabs/plugin-sdk/dist/hook-plugin.js')));
assert.ok(fs.existsSync(path.join(root, 'node_modules/zod/LICENSE')));
console.log(JSON.stringify({ pluginId: manifest.pluginId, version: manifest.version, standaloneLoad: true, translations: Object.keys(pt).length }));
