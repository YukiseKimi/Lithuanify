<p align="center">
  <img src="docs/iron-wolf.svg" alt="Lithuanify — the Iron Wolf of Vilnius" width="168">
</p>

<h1 align="center">Lithuanify</h1>

<p align="center">
  A Safari Web Extension that shows English translations in small letters
  <strong>above</strong> Lithuanian words as you read — like Japanese <em>furigana</em>.
</p>

> The logo is an **Iron Wolf** (*Geležinis Vilkas*) — an homage to the legend of
> Grand Duke Gediminas, whose dream of an iron wolf howling on a hilltop led him
> to found **Vilnius**.

Lithuanian text on a page is annotated in place with `<ruby>` elements, so each
word keeps its original form while a concise English gloss sits on top.

## How translation works

Lithuanify is **hybrid**, and prefers to run entirely on your device:

1. **On-device AI (primary).** Apple's [FoundationModels](https://developer.apple.com/documentation/foundationmodels)
   framework (Apple Intelligence) produces *context-aware* per-word glosses, so a
   word gets the meaning that fits the sentence rather than a generic dictionary
   entry. This is free, private, and offline. Requires Apple Intelligence to be
   enabled on a supported device.
2. **Offline dictionary.** A built-in list of common Lithuanian words handles
   frequent vocabulary instantly.
3. **Online word lookup (fallback).** For words the model isn't available for or
   skips, a free translation endpoint fills the gap. Results are cached so each
   word is fetched at most once.

> Note: Apple's *Translation* framework can't be used here — it only vends a
> session from a SwiftUI view, and a web extension's native handler is headless.
> FoundationModels works headlessly, which is why it powers the glosses.

## Features

- Furigana-style English glosses above Lithuanian words.
- Context-aware meanings via the on-device language model.
- **Priority + visible-first scheduling:** on-screen text translates first, then
  the rest fills in by priority (title → body → navigation/menus last).
- **Foreground-only:** only the active tab spends the model; background tabs pause.
- **Performance:** model prewarming and a persistent gloss cache for fast
  revisits.
- Diacritic-insensitive matching and gap-fill so words aren't left untranslated.
- Toolbar popup to toggle the extension and the on-device AI on/off, and to see
  whether the on-device model is available.

## Project layout

| Path | Purpose |
|------|---------|
| `Shared (Extension)/Resources/content.js` | Page scanning, furigana rendering, scheduling, dictionary |
| `Shared (Extension)/Resources/background.js` | Bridges JS ↔ native, caching, online fallback |
| `Shared (Extension)/Resources/popup.*` | Toolbar popup UI |
| `Shared (Extension)/SafariWebExtensionHandler.swift` | Native handler running on-device translation |
| `Shared (App)/` | Container app that hosts and enables the extension |

## Building & running

1. Open `Lithuanify.xcodeproj` in Xcode.
2. Select the **Lithuanify (macOS)** scheme and run it once (this registers the
   extension with Safari).
3. In Safari: **Settings → Advanced →** enable *Show features for web developers*.
4. **Develop → Allow Unsigned Extensions** (needs redoing each Safari launch for
   development builds).
5. **Settings → Extensions →** enable **Lithuanify** and allow it on every website.
6. Visit a Lithuanian page (e.g. `lt.wikipedia.org`) — English glosses appear
   above recognised words.

## Requirements

- Xcode and a recent macOS/iOS (Safari Web Extensions, Manifest V3).
- For the on-device AI path: a device with **Apple Intelligence** enabled.
  Without it, Lithuanify automatically falls back to the dictionary + online
  lookup.

## License

[MIT](LICENSE)
