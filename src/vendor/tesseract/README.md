# Vendored: Tesseract.js

The OCR engine behind **Read text in images**. Every file here is copied byte-for-byte from the
published npm packages below — nothing is modified, rebuilt or re-minified — so a reviewer can
check each one against the registry.

| File | Package | From |
| --- | --- | --- |
| `tesseract.min.js` | [`tesseract.js@7.0.0`](https://www.npmjs.com/package/tesseract.js/v/7.0.0) | `dist/tesseract.min.js` |
| `worker.min.js` | `tesseract.js@7.0.0` | `dist/worker.min.js` |
| `tesseract.min.js.LICENSE.txt`, `worker.min.js.LICENSE.txt` | `tesseract.js@7.0.0` | `dist/` (third-party notices the bundles point at) |
| `tesseract-core-simd-lstm.wasm.js` | [`tesseract.js-core@7.0.0`](https://www.npmjs.com/package/tesseract.js-core/v/7.0.0) | package root |
| `eng.traineddata.gz` | [`@tesseract.js-data/eng@1.0.0`](https://www.npmjs.com/package/@tesseract.js-data/eng/v/1.0.0) | `4.0.0_best_int/eng.traineddata.gz` |
| `LICENSE.txt` | `tesseract.js@7.0.0` | `LICENSE.md` (Apache 2.0; `tesseract.js-core` is under the same licence) |

Readable source for each, at the same release:
[tesseract.js v7.0.0](https://github.com/naptha/tesseract.js/tree/v7.0.0),
[tesseract.js-core v7.0.0](https://github.com/naptha/tesseract.js-core/tree/v7.0.0) (the
Emscripten build of Tesseract itself, which is where the WebAssembly comes from), and
[the language data](https://github.com/naptha/tessdata/tree/gh-pages/4.0.0_best_int).

SHA-256:

```
000c27d9cd0def655f77b36c72a389c0ab13793aa31cb4d7aab56d09c0afbc7e  tesseract.min.js
576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d  worker.min.js
c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38  tesseract-core-simd-lstm.wasm.js
45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91  eng.traineddata.gz
```

Why these variants:

- **`simd-lstm` core only.** `src/ocr.js` names the core file directly instead of letting
  Tesseract.js pick one by feature detection, so only one of the eight builds ships. Firefox has
  had WebAssembly SIMD since 89, well below the extension's floor of 115. The LSTM-only build is
  enough because the extension always runs the LSTM engine (`OEM.LSTM_ONLY`).
- **`best_int` English model**, the default Tesseract.js uses for LSTM: ~3 MB against ~11 MB for
  the full `4.0.0` model, with little difference on the short, large text in memes and
  thumbnails.
- **Nothing is fetched at run time.** Tesseract.js falls back to jsDelivr for any path it isn't
  given; `src/ocr.js` gives it all three (worker, core, language), and caching to IndexedDB is
  switched off, since the model already ships with the extension.

To update, download the new tarballs from the registry, copy the same files across, update the
table and hashes, and run `dev/ocr-engine.html` (see `dev/PACKAGING.md`).
