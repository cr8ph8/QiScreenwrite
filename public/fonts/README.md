# Offline writer fonts

These are unmodified TrueType font files and the original SIL Open Font License
1.1 texts downloaded from the official [Google Fonts repository](https://github.com/google/fonts).
All downloads are pinned to commit
[`23e54b51ddffbc7713c583748e3bd86f62b1fa4a`](https://github.com/google/fonts/commit/23e54b51ddffbc7713c583748e3bd86f62b1fa4a).
No fonts are fetched from a network font service at runtime.

| CSS family | Included faces | Official source and copied license |
| --- | --- | --- |
| Inter | Normal and italic variable fonts; weight 100–900, optical size 14–32 | [Google Fonts source](https://github.com/google/fonts/tree/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/inter), [OFL.txt](inter/OFL.txt) |
| Playfair Display | Normal and italic variable fonts; weight 400–900 | [Google Fonts source](https://github.com/google/fonts/tree/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/playfairdisplay), [OFL.txt](playfairdisplay/OFL.txt) |
| JetBrains Mono | Normal and italic variable fonts; weight 100–800 | [Google Fonts source](https://github.com/google/fonts/tree/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/jetbrainsmono), [OFL.txt](jetbrainsmono/OFL.txt) |
| Courier Prime | Regular, italic, bold and bold italic; weight 400/700 | [Google Fonts source](https://github.com/google/fonts/tree/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/courierprime), [OFL.txt](courierprime/OFL.txt) |

The ten font files total 3,046,244 bytes (2.91 MiB). Original TTFs preserve all
upstream glyph coverage, font names, hinting and variation data; they have not
been subsetted, renamed internally or converted. The source directories provide
TTFs. Normal and italic faces are separate so the browser need not synthesize
italics. Each font is requested only when its face is used.

Copyright holders, as recorded in the copied licenses:

- Inter: Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter).
- Playfair Display: Copyright 2017 The Playfair Display Project Authors
  (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name
  "Playfair Display".
- JetBrains Mono: Copyright 2020 The JetBrains Mono Project Authors
  (https://github.com/JetBrains/JetBrainsMono).
- Courier Prime: Copyright 2015 The Courier Prime Project Authors
  (https://github.com/quoteunquoteapps/CourierPrime).

Retain each family's complete `OFL.txt` when redistributing the font bundle.

## Integration and verification

The definitions live in `src/local/fonts.css`. Import that stylesheet from the
local app entry point alongside the existing styles. The CSS uses the existing
family names exactly and contains only same-origin `/fonts/…` URLs, with
`font-display: swap` and no network imports or installed-font substitutions.
Vite copies `public/fonts/` into `dist-local/fonts/`; desktop packaging copies
that output into `Contents/Resources/runtime/dist-local/fonts/`.

After integrating and packaging, verify all ten faces with
`document.fonts.load()` in the installed WKWebView, with external networking
unavailable. Verify the Network panel has only loopback font requests, and check
headings, normal/bold/italic UI text, and screenplay text/preview. This stylesheet
does not change PDF export's separate font configuration.

To reproduce a download, use
`https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/<family>/<filename>`
with the path URL-encoded as needed. Family directories and filenames below match
the upstream source exactly. Checksums are SHA-256 of the downloaded bytes:

```text
29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031  inter/Inter[opsz,wght].ttf
acd98e64795781b2058f07b18475e0ecee2a0fe2b42a49e2f9e37d0d6bf66ce6  inter/Inter-Italic[opsz,wght].ttf
5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57  inter/OFL.txt
c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6  playfairdisplay/PlayfairDisplay[wght].ttf
a5e26dc5e2e77fb2803a0bf02fd4f81ee136ec8dea863ccdb0c59a263b21378b  playfairdisplay/PlayfairDisplay-Italic[wght].ttf
566be814f8e96e93dfa16101331557eb6b5467e9e03f627c0910fe93ca12300e  playfairdisplay/OFL.txt
48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda  jetbrainsmono/JetBrainsMono[wght].ttf
85ae2a5cd3f56baf1ce1c21a851322c58e3d8fbe8e8ad4a4d090a820dd7fe558  jetbrainsmono/JetBrainsMono-Italic[wght].ttf
b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d  jetbrainsmono/OFL.txt
72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af  courierprime/CourierPrime-Regular.ttf
f1b9a5829789f7e56432a9f3bc7665ef4531dbba1c112639e48bef39621a006b  courierprime/CourierPrime-Italic.ttf
ff1f38786c849d1c41fa8e447960abdb2bd75fdfb0cfcdeb524fad65a5af3638  courierprime/CourierPrime-Bold.ttf
3355273f3ea6d6362658f9564f4e83d59e156cf1a182e3c1592b5c5943627dcc  courierprime/CourierPrime-BoldItalic.ttf
9a755af092b494944c99f471be6fddd19b006a448fefdc4717e4ee0aa09a97b0  courierprime/OFL.txt
```
