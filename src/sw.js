/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — Chromium service worker entry.

   Named only in manifest.chrome.json; Firefox never loads it. MV3 allows a
   single background entry, so the files the Firefox manifest lists under
   background.scripts are pulled in here, in the same order — with two
   differences, both forced by a service worker having no DOM:

     ocr.js and vendor/tesseract/ are replaced by ocr-bridge.js. The worker
     cannot spawn the dedicated Worker the engine needs, so the engine runs in
     an offscreen document (offscreen.html), and ocr-bridge.js passes reads
     across to it under the same OCR.read that background.js calls.

     downloads — manifest.chrome.json grants no downloads permission, so
     browser.downloads is undefined, canDownload() answers false, and
     writeBackup() returns before it reaches URL.createObjectURL, which a
     service worker does not have either. That toggle is hidden from the
     settings page in this build (see dev/package.py), so the dead path can't
     be switched on by hand. */

importScripts('compat.js', 'common.js', 'ocr-bridge.js', 'background.js');
