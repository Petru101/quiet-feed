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

   The document is opened on the first read and left open while the feature
   is on. Its engines shut down after a quiet minute on their own (ocr.js),
   and what it keeps after that is the cache of pictures already read, which
   is worth keeping: the service worker itself is stopped whenever Chrome
   likes, and would lose it. Once the feature is off it is closed, cache and
   all, rather than staying in the browser's task manager reading nothing. */

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

  /* Off means the setting is off, or no image host is allowed any more: the
     settings page hands the permission back when it's switched off, and it
     can also be taken back from the browser's own extension settings. */
  function wanted() {
    return Promise.all([
      WF.loadConfig(),
      Promise.all(WF.OCR_ORIGINS.map(function (origin) {
        return browser.permissions.contains({ origins: [origin] })
          .catch(function () { return false; });
      }))
    ]).then(function (got) {
      return !!got[0].ocr && got[1].some(Boolean);
    });
  }

  function closeIfOff() {
    return Promise.resolve(opening).catch(function () { }).then(wanted).then(function (on) {
      if (on) return;
      return browser.offscreen.hasDocument().then(function (open) {
        if (open) return browser.offscreen.closeDocument();
      });
    }).catch(function () { });
  }

  browser.storage.onChanged.addListener(function (changes) {
    if (changes.wfConfig) closeIfOff();
  });
  browser.permissions.onRemoved.addListener(closeIfOff);
  // Both events wake a stopped worker; this is the floor for one that slipped by.
  closeIfOff();

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
