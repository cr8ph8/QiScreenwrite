# Contributing

Start with the README and open an issue describing the concrete writing workflow you want to improve. This is a development preview; focused fixes, accessible interaction, import/export cases and documentation are welcome.

Use Node.js 24.18.0, run `npm ci`, and run the checks in the README before submitting a pull request. Native changes also need the appropriate Swift tests and simulator/macOS checks. Describe what you exercised and what remains unverified.

Preserve the following behavior:

- Authoring works offline without a hosted login.
- Screenplay text survives editing, pagination, import/export and restart without silent loss.
- Saved revisions remain immutable; recovery and explicit saved history remain distinct.
- Connectors identify the destination and exact source revision, require explicit user action and preserve conflicting edits.
- Costs, purchases and server-owned balances cannot be invented or trusted from the client.
- Attribution and third-party notices travel with redistributed code and assets.

Use synthetic screenplays and test identities. Do not attach real scripts, private co-writer agreements, runtime databases, `.env` files, credentials, signing material or exported project snapshots to issues or pull requests.

Contributions are offered under this repository’s MIT License unless a file carries a different notice. Only contribute material you have authority to share under its stated license. Keep dependency and font licenses intact.
