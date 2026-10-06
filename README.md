# Address Book Sync

Save unknown arriving group members using their learned WhatsApp push name, persisted identity display name, or username, plus a configured suffix. If none is available, wait for a name instead of saving a phone-number label.

Standalone WABS package `official.address-book-sync` version `0.3.4`, requiring WABP core API `^0.3.12`. The archive includes its runtime dependencies and Portuguese translations. WABP owns scope configuration, enabled state, identity resolution, durable jobs, plugin data, and authorized conditional contact writes.

Install through a trusted WABS registry entry and its immutable archive SHA-256. Installation and scope enablement are separate operations.

For development, run `npm ci --ignore-scripts`, `npm test`, then `npm run release:archive`. Tests use fixture identities and mocked host capabilities. CI checks Node22.23.2 and24.15.0 and archive reproducibility.

`provenance.json` records the imported source history and exact SDK input. Runtime imports use the SDK contract, with no host or sibling plugin source dependency.

Account-administrator backfill and repair are declared plugin actions. The host supplies account-scoped contacts, covered-group checks, prior action records and authorized mutations; no host implementation is imported.

Arrivals enqueue durable work. Later messages, startup recovery, and a 15-minute reconciliation scan revisit pending names and failed writes. Retries back off through 1 minute, 5 minutes, 30 minutes, and 6 hours, rounded up to a shared minute bucket. Due contacts share one group scan. Message wakeups only revisit pending contacts and read the event group. Successful writes are confirmed by reading the account address book; failures are never recorded as successful deduplication. The legacy `dedupeTtlSeconds` configuration is accepted for compatibility, but confirmed address-book state now prevents duplicate saves.

The default backfill mode, `sync-members`, previews both missing contacts and old plugin-created phone fallbacks. `unknown-members` and `repair-phone-fallbacks` remain available. Repairs accept both historical receipt formats (`contactName` and `displayName`), require the saved name to still match the exact recorded fallback, and retain its original suffix. Manual edits, existing named contacts, exempt groups, nonmembers, the bot itself, and groups outside MANAGE coverage are protected. If some arrival types are disabled, automatic catch-up discovers only explicitly eligible arrivals and existing pending/repair work.

Default reconciliation also repairs the exact historical duplicated-surname pattern: the saved first-name field must equal a successful plugin receipt, and the full name must be that recorded label followed by its surname/suffix a second time. Both current fields are checked again before writing. The original receipt label is restored, including its historical suffix. Other edits and legacy backfill modes remain unchanged.
