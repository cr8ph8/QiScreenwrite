# QiScreenwrite

**Local screenwriting, story development and connected worlds.**

QiScreenwrite is the open-source home of the local QiCanIScreenwrite apps: a screenwriting studio for macOS and the browser, plus a native iPhone companion. Write screenplay pages, develop characters and worlds, keep revisions, and export your work without a hosted account.

Our direction is to connect this private writing workspace to [CanIScreenwrite.com](https://caniscreenwrite.com) through optional, reviewed exchanges for scoring, competitions and creative services. Local authoring stays usable offline. The hosted service remains a separate system. See the [connection plan](docs/CANISCREENWRITE-CONNECTION.md) for what exists and what still needs to ship.

This is a **development preview**, released under the [MIT License](LICENSE). The native apps retain their existing QiCanIScreenwrite display names, file formats and workspace identifiers for compatibility. This repository does not include private screenplays, account credentials or the hosted competition backend.

## What you can do

| Area | Desktop / local browser | iPhone |
|---|---|---|
| Write | Page and Fountain editing, scene navigation, title page, find/replace and scene cards | Numbered drafting pages, Fountain source, element menu and compact keyboard controls |
| Develop | Concepts, loglines, synopsis, outline, beats, characters and research | Local development fields and research |
| Build worlds | Elements, relationships, scene links, shared local worlds and reviewed updates | Elements, relationships and scene links |
| Keep work | Explicit revision history, working-copy recovery, backups and preservation packages | Automatic working-copy saving and explicit revision checkpoints |
| Export / exchange | Fountain, common FDX elements, PDF, DOCX, reports and `.qiscript` project snapshots | Fountain and `.qiscript` project snapshots |
| Collaborators / rights | Local contribution records and proposed split worksheets | Rights records stay with the originating desktop system |
| Optional analysis | Adapter for a user-configured local Ollama server | Adapter for an explicitly configured Ollama machine on a private network |

There is no claim of complete Final Draft, WriterDuet or Celtx compatibility. Real-time co-writing, production page locking, complete proprietary FDX fidelity and automated cross-device synchronization remain future work. iPhone page counts estimate screenplay layout; desktop PDF export is the current print-layout reference.

The public edition includes 17 original film-language reference entries and writing exercises with public further-reading links. Personally supplied course materials and screenplays are not distributed.

## Run the local studio

Use **Node.js 24.18.0** and npm. macOS is the native build target; Linux and Windows runtime acceptance remain to be completed. Dependencies are downloaded during setup; everyday authoring runs locally afterward. This source release does not include a prebuilt installer.

```sh
git clone https://github.com/cr8ph8/QiScreenwrite.git
cd QiScreenwrite
npm ci
npm run build
npm start
```

The service listens on `127.0.0.1:4318` and opens a short-lived local login link. The default browser workspace is `.local-writer/` in this checkout. No account or API key is needed for local authoring. `npm run local:serve` starts the same service without opening a browser.

For development, keep the local service running and start `npm run dev` in a second terminal. It serves the interface at `http://127.0.0.1:5178` and proxies the local API. Keep the service bound to loopback; it is a personal writing workspace, not a public web server.

## Start a screenplay

1. Open **My drafts**, create a draft or import Fountain/text/common FDX.
2. Choose **Page** for formatted writing or **Fountain** for source text. Save with **Save** or **Command/Ctrl-S**.
3. Open **Develop** for the story and **World Builder** for connected elements, rules and places. Save development changes explicitly on desktop.
4. Use **History** to compare revisions. Restoring brings an earlier version into your working copy; previous saved revisions remain.
5. Export the format you need. Use **Back up** for saved workspace history and keep independent copies outside the app’s data folder.

See [Using QiScreenwrite](docs/USAGE.md), [the desktop guide](local/DESKTOP-GUIDE.md) and [iPhone setup](iphone/README.md).

## Build the macOS app

macOS 14 or later and Xcode’s command-line tools are required. With the pinned Node version active:

```sh
npm ci
npm run desktop:build
```

The packager prints the staged `.app` location and records it in `build-desktop/latest.json`. Copy that app into your Applications folder yourself. The bundle contains its local service and Node runtime. The normal native workspace is `~/Library/Application Support/QiCanIScreenwrite/Workspace`; replacing the app does not replace this data.

Development bundles use local ad-hoc signing. A notarized downloadable release is separate work; do not disable macOS security protections to install an untrusted build.

## Build the iPhone app

Use Xcode with the FoundationModels SDK (Xcode 26 or later; checked here with Xcode 27). Open `iphone/QiCanIScreenwrite.xcodeproj`, select the **QiCanIScreenwrite** scheme and an iPhone simulator, then Run. For a physical phone, select your own signing team and complete Apple’s device setup. No developer certificate or provisioning profile is included here.

Open a screenplay → **Write → Pages**. Tap the page count to jump. While typing, the keyboard toolbar provides element selection, Undo/Redo and Hide keyboard. Enter continues common screenplay elements. Writing and world-building work without a desktop connection.

To move work, export a `.qiscript` project copy, transfer it through Files/AirDrop or another method you choose, and review the import on the other device. Transfers create independent copies; they are not live sync. Project copies carry current creative content, not the source device’s full history, rights ledger or credentials. See the [exchange contract](iphone/CONTRACT.md).

## Optional connections

- **CanIScreenwrite.com:** the public build has no production backend credentials. Existing adapters provide a starting point for an explicitly configured hosted deployment. Scoring, submission, judging, payments and account administration require the separate service and their own acceptance checks. [Read the connection plan.](docs/CANISCREENWRITE-CONNECTION.md)
- **QiMovi / FilmStack:** the desktop app can connect to a compatible local project service for reviewed screenplay/world transfers. QiMovi is not bundled. A transfer does not approve production or establish rights ownership. Phone projects reach this route through desktop exchange.
- **Local models:** use your own Ollama installation and chosen model. No model is bundled or downloaded automatically. A phone’s `127.0.0.1` is the phone itself; a model running on your Mac needs an explicitly configured private-network address. Platform token purchases and hosted paid analysis are not enabled in the public release.

## Privacy, ownership and contributions

Your screenplay files belong in your private workspace, not in this repository. Local storage, backups, transfer files and rights attachments can contain private creative work. The software license does not transfer ownership of what you write or clear third-party material you import.

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Contributions should preserve source text, revision history, explicit transfer review and offline operation. Use synthetic examples in issues and tests.

## Development checks

```sh
npm run check
npm test
npm run test:local
npm run build
swift test --package-path iphone/Core
```

Cross-app integration checks requiring a separate QiMovi installation are optional and must be distinguished from portable tests. Native app interaction and packaging checks are separate from a green web build. See [the roadmap](docs/ROADMAP.md) for the remaining release work.

A [GitHub Actions workflow example](docs/github-actions-ci.yml.example) is included. Automation is not enabled in this initial upload; an authorized maintainer can copy it to `.github/workflows/ci.yml`.

## Local brand integration

Open a saved draft → **Brands & financing** to scan and review placement
opportunities offline. **Read linked financing** uses an explicit prior draft
transfer to the updated local QiMovi service; it never signs deals or copies the
financial ledger. See [the workflow, installation and authority boundaries](docs/BRAND-INTEGRATION.md).

The feature workflow validates the local app and produces a development macOS
arm64 bundle. It does not install itself on your computer or update the iPhone app.
