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

Lithuanify runs **entirely on your device**, in two tiers:

1. **Offline dictionary (instant).** A built-in list of common Lithuanian words
   is rendered in the first frame, before any model work starts.
2. **On-device AI (fills the gaps).** Words the dictionary doesn't know are sent,
   batched by what's on screen, to Apple's [FoundationModels](https://developer.apple.com/documentation/foundationmodels)
   framework (Apple Intelligence), which returns a *context-aware* meaning for
   each one. The model only returns a number and a meaning per word, so its
   output stays short. Requires Apple Intelligence on a supported device.

Nothing is sent to the network. Model results are cached per text block in
IndexedDB, so revisited pages don't touch the model again. Pages that don't
look Lithuanian are left alone.

> Note: Apple's *Translation* framework can't be used here — it only vends a
> session from a SwiftUI view, and a web extension's native handler is headless.
> FoundationModels works headlessly, which is why it powers the glosses.

## Features

- Furigana-style English glosses above Lithuanian words.
- **Three translate modes**, picked in the toolbar popup:
  - *Whole page*: every word, on-screen text first.
  - *Paragraph under pointer*: only the paragraph the pointer rests on.
  - *Selected text*: only the words you highlight. This also works on pages
    that don't look Lithuanian. On iPhone and iPad, where there is no hover,
    this is the mode to use.
- Context-aware meanings via the on-device language model.
- **Priority + visible-first scheduling:** on-screen text translates first, then
  the rest fills in by priority (title → body → navigation/menus last).
- **Foreground-only:** only the active tab spends the model; background tabs pause.
- **Performance:** dictionary glosses render instantly; a prewarmed model
  session is reused per request; a persistent IndexedDB gloss cache makes
  revisits instant. Timings are logged to the Web Inspector console.
- Diacritic-insensitive dictionary matching.
- Toolbar popup to toggle the extension and the on-device AI on/off, pick the
  translate mode, and see whether the on-device model is available.

## Project layout

| Path | Purpose |
|------|---------|
| `Shared (Extension)/Resources/content.js` | Page scanning, furigana rendering, scheduling, dictionary |
| `Shared (Extension)/Resources/background.js` | Bridges JS ↔ native, gloss cache (IndexedDB) |
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
  Without it, Lithuanify uses the offline dictionary only.

## License

[MIT](LICENSE)
