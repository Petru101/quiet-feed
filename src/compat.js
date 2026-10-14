/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — Chromium compatibility shim.

   Named only in manifest.chrome.json, so Firefox never loads it and nothing
   else in src/ had to change to make the Chromium build work.

   Firefox exposes the extension APIs as both `browser` and `chrome`; Chromium
   historically only as `chrome`. Under MV3 the chrome.* methods return a
   promise when no callback is passed, which is exactly what the rest of the
   code already expects, so aliasing the namespace is enough — no per-method
   wrapping, and no behaviour that differs between the two builds.

   Worth knowing before trusting it: every browser this has actually been run
   in — Chrome 153, Edge 153, Opera 136 — already provides its own `browser`,
   distinct from `chrome` and promise-based, so the guard below never fires and
   this file currently does nothing anywhere. It is kept as a cheap floor for
   older Chromium and for the other forks, not because anything measured needs
   it. If it ever does start mattering, nothing else has to change.

   This has to run before common.js, content.js or background.js touch
   `browser`, which the manifest guarantees by listing it first. */

(function () {
  'use strict';

  if (typeof globalThis.browser === 'undefined' && typeof globalThis.chrome !== 'undefined') {
    globalThis.browser = globalThis.chrome;
  }
})();
