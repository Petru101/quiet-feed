/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — the Chromium offscreen document that reads text in images.

   Named only in the Chromium build; Firefox runs ocr.js in its background
   page and never loads this. Opened by ocr-bridge.js in the service worker,
   which has already checked the URL and the permission; this only runs the
   engine. */

(function () {
  'use strict';

  /* Only the service worker asks. A content script's messages reach this
     document too, and must not get around the checks made there. */
  browser.runtime.onMessage.addListener(function (msg, sender) {
    if (!msg || msg.type !== 'wf-ocr-run' || sender.tab) return;
    return OCR.read(msg.url, msg.key).then(function (text) {
      return { text: text };
    }, function (err) {
      return { error: String((err && err.message) || err) };
    });
  });
})();
