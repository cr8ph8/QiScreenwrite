# QiScreenwrite for iPhone

A native, offline writing companion, currently displayed as QiCanIScreenwrite. Its local library is independent of the Mac workspace. No account is needed for writing, development, worlds or revision history.

## Build and run

Use a Mac with full Xcode and an iOS SDK that includes FoundationModels (Xcode 26 or later; this source snapshot is checked with Xcode 27). The deployment target is iOS 17; on-device model features also require a supported device and system availability.

1. Open `iphone/QiCanIScreenwrite.xcodeproj` in Xcode.
2. Select the QiCanIScreenwrite scheme and an available iPhone simulator, then Run.
3. For a physical phone, choose your own Apple signing team in Signing & Capabilities, use a unique bundle identifier if required, and follow Xcode's device setup. No signing identity is included.

If you add or remove Swift sources, regenerate the shared project from the repository root with `python3 iphone/scripts/generate-project.py`. The generator intentionally has no signing team.

## Writing and exchange

Create a screenplay or import Fountain / a `.qiscript` project copy. Open Write → Pages for numbered drafting pages; use the element menu and keyboard toolbar while typing. Fountain mode exposes the underlying source. Page counts are estimates; use desktop PDF export for print-layout review.

The app automatically saves the working copy. Create explicit revisions when you want a checkpoint. Develop characters, story fields and world relationships alongside the script. Use export and Files/AirDrop to keep independent backups or move a project to the desktop.

Project imports create independent copies, not live synchronization. They carry current creative content rather than full revision history, rights records or credentials. Read the [exchange contract](CONTRACT.md). QiMovi transfers use the desktop bridge after reviewing a project copy there.

## Optional analysis

The creative services screen supports an explicitly configured local Ollama endpoint and optional hosted service adapter. Hosted configuration defaults to disabled. Token purchases are unavailable. See [the service guide](QiCanIScreenwrite/Services/README.md). A phone's loopback address points to the phone; a Mac model requires its explicit private-network address.

## Checks

From the repository root:

```sh
swift test --package-path iphone/Core
node iphone/scripts/export-film-language.mjs --check
node iphone/scripts/check-exchange.mjs
xcodebuild -project iphone/QiCanIScreenwrite.xcodeproj -scheme QiCanIScreenwrite -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/qiscreenwrite-ios-build CODE_SIGNING_ALLOWED=NO build
```

Core tests and simulator builds do not establish physical-device sharing, App Store distribution, model availability or hosted service acceptance. `scripts/prepare-page-ui-tests.py` can generate a separate UI-test project in a chosen scratch directory; the normal app scheme does not contain the UI-test target.
