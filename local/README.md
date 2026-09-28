# Local writer service

This directory contains the offline Node service, private SQLite workspace storage, Mac service host, shared contracts and synthetic regression tests. Start at [the repository README](../README.md) and [usage guide](../docs/USAGE.md).

`npm run build` builds the interface. `npm start` serves it on numeric loopback and opens a one-time login link. For a separate workspace, use `npm start -- --data /path/to/private-workspace`. Do not expose the service to the public network or commit workspace data.

`npm run test:local` uses disposable synthetic workspaces. Tests that inspect a separately installed QiMovi application or a private sibling checkout are not part of this public suite. Contract and HTTP tests use synthetic peer services instead.
