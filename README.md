# Address Book Sync

Save unknown arriving group members using push name, username, or phone number, plus a configured suffix.

Standalone WABS package `official.address-book-sync` version `0.2.2`, requiring WABP core API `^0.3.2`. The archive includes its runtime dependencies and Portuguese translations. WABP owns scope configuration, enabled state, identity resolution, ephemeral state and action authorization; extracting the code preserves their identifiers and stored values.

Install through a trusted WABS registry entry. Installation and scope enablement are separate operations. The publisher signs exact archive bytes; registry branding alone does not establish trust.

For development, run `npm ci --ignore-scripts`, `npm test`, then `npm run release:archive`. Tests use fixture identities and mocked host capabilities. CI checks Node22.23.2 and24.15.0 and archive reproducibility.

`provenance.json` records the imported source history and exact SDK input. Runtime imports use the SDK contract, with no host or sibling plugin source dependency.

Account-administrator backfill and repair are declared plugin actions. The host supplies account-scoped contacts, covered-group checks, prior action records and authorized mutations; no host implementation is imported.
