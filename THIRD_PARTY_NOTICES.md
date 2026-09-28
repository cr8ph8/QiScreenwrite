# Third-party notices

Original QiScreenwrite source and documentation are licensed under the root MIT License. That license does not replace notices carried by third-party material or grant ownership of a writer’s creative work.

## Fonts

The bundled Inter, Playfair Display, JetBrains Mono and Courier Prime fonts are distributed under their original **SIL Open Font License 1.1** texts. Keep each `public/fonts/*/OFL.txt` with its font files. [Font sources and checksums](public/fonts/README.md) are included.

## Node.js and JavaScript packages

Dependencies retain their upstream licenses. The package lock records the resolved versions. The macOS packaging script collects installed package license texts and includes the matching Node.js license from `desktop/Resources/` in the generated bundle’s `ThirdPartyNotices.txt`.

The supported packaging runtime is Node.js 24.18.0. If changing that version, obtain its corresponding official Node.js license before bundling it; do not reuse the license file for a different runtime.

## Reference material and branding

Reference links identify external sources; their pages, illustrations, videos and teaching materials are not included in the software license. Imported screenplays, user research and agreements remain with their owners and are not part of this source release. The project’s name and logo identify the original application; the code license does not grant trademark rights.

## UI scaffolding

The retained components in `src/components/ui/` are adapted from [shadcn/ui](https://github.com/shadcn-ui/ui), copyright 2023 shadcn, distributed under MIT. Its complete notice is retained in [THIRD_PARTY_LICENSES/shadcn-ui-MIT.txt](THIRD_PARTY_LICENSES/shadcn-ui-MIT.txt). Radix and other packages retain their own dependency notices.

## Shared QiMovi contracts

`local/contracts/qimovi/` contains the pinned participation and creative-project contracts used by the local writer, originally developed within QiMovi / FilmStack. `SOURCE.json` records their original file hashes. Inclusion of these specific files does not license the separate QiMovi product or imply a production connection is installed.
