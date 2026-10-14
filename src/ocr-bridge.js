/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — reading text in images, Chromium side of the service worker.

   Named only in sw.js; Firefox never loads it. A service worker has no DOM
   and cannot spawn the dedicated Worker the engine needs, so the engine runs
   in an offscreen document (offscreen.html) instead, and this stands in for
   ocr.js inside the worker: the same OCR.read(url, key) background.js already
   calls, passed across to that document. background.js is unchanged, and so
   are its checks — the URL and the permission are settled here, before
   anything reaches the engine.

   The document is opened on the first read and left open. Its engines shut
   down after a quiet minute on their own (ocr.js), and what it keeps after
   that is the cache of pictures already read, which is worth keeping: the
   service worker itself is stopped whenever Chrome likes, and would lose it. */

var OCR = (function () {
  'use strict';

  var DOC = 'src/offscreen.html';
  var opening = null;

  /* Chromium allows one offscreen document per extension, and creating a
     second throws. Reads arrive two at a time, so they share one opening. */
  function ensureDocument() {
    if (opening) return opening;
    opening = browser.offscreen.hasDocument().then(function (open) {
      if (open) return;
      return browser.offscreen.createDocument({
        url: DOC,
        reasons: ['WORKERS'],
        justification: 'Reads the text in post pictures on this device, with the bundled OCR engine.'
      });
    }).then(function () {
      opening = null;
    }, function (err) {
      opening = null;
      throw err;
    });
    return opening;
  }

  function read(url, key) {
    return ensureDocument().then(function () {
      return browser.runtime.sendMessage({ type: 'wf-ocr-run', url: url, key: key });
    }).then(function (reply) {
      if (!reply) throw new Error('the reader did not answer');
      if (reply.error) throw new Error(reply.error);
      return reply.text || '';
    });
  }

  return { read: read };
})();
