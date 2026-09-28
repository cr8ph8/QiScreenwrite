# QiScreenwrite desktop guide

Build the native Mac app with `npm ci` and `npm run desktop:build` from the repository root. Read `build-desktop/latest.json` for the generated bundle location, then copy the app to Applications. It currently retains the QiCanIScreenwrite display name and workspace identifier.

Open the app from Applications. Its Node service and fonts are bundled; normal writing needs no account or internet. The workspace is `~/Library/Application Support/QiCanIScreenwrite/Workspace`. Keep it private and make independent backups. The browser workspace defaults to `.local-writer` and is separate from this native workspace.

Create a draft in My drafts. Write in Page or Fountain view, save a revision with Command-S, and use History to compare or restore earlier work. Development and world changes have their own Save development action. Working-copy recovery helps after interruption; it does not replace backups.

Use Export for Fountain, FDX, PDF or DOCX, and project exchange for `.qiscript` copies. Project exchange carries current creative content; Back up preserves workspace history. Review each import and cross-app transfer before applying it.

CanIScreenwrite.com services are optional and unconfigured in the public build. A separate QiMovi / FilmStack service is required for its bridge. A model is never bundled or downloaded automatically.

These are development bundles with ad-hoc signatures, not notarized releases. Build architecture follows the build machine; universal distribution and clean-machine installation require separate release testing. See the repository README, docs/USAGE.md and docs/ROADMAP.md for setup, workflows and remaining work.
