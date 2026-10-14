/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — reading text in images. Optional, off by default.

   Runs in the background page, not the content script, for two reasons. A
   content script can't read the pixels of another site's image (the canvas is
   tainted), while the background page can fetch it outright once the user has
   granted the image hosts. And the engines are shared by every tab instead
   of started in each one, and shut down after a quiet minute.

   Everything is bundled: the engine, its WebAssembly core and the English
   model all load from the extension itself, never from a CDN. The only
   request this makes is for the image the page is already showing. */

var OCR = (function () {
  'use strict';

  var BASE = (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL)
    ? browser.runtime.getURL('src/vendor/tesseract/')
    : new URL('vendor/tesseract/', document.currentScript.src).href;   // dev pages

  var IDLE_MS = 60000;            // free the engine's memory after a quiet minute
  var MAX_BYTES = 12 * 1024 * 1024;
  var TARGET_WIDTH = 1200;        // thumbnails are ~480px; text reads far better upscaled
  var MAX_SCALE = 3;
  var MAX_SIDE = 2400;
  var CACHE_MAX = 1500;

  /* Tesseract reports a confidence per word. Busy backgrounds — a thumbnail's
     face, a meme's texture — come out as scraps of letters, and a scrap that
     happens to spell a blocked word hides an innocent post. So anything it
     isn't fairly sure of is dropped before matching. */
  var MIN_CONFIDENCE = 60;

  var workerPromise = null;
  var busy = 0;
  var idleTimer = null;
  var cache = new Map();          // image key -> text, oldest first
  var inflight = new Map();       // image key -> Promise<text>

  function createWorker() {
    return Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
      workerPath: BASE + 'worker.min.js',
      corePath: BASE + 'tesseract-core-simd-lstm.wasm.js',
      langPath: BASE.replace(/\/$/, ''),
      workerBlobURL: false,     // a blob: worker can't importScripts from moz-extension:
      cacheMethod: 'none',      // the model ships with us; nothing to cache in IndexedDB
      gzip: true
    }).then(function (worker) {
      // Sparse text: captions and thumbnail slogans are scattered words,
      // not paragraphs, and the default page layout analysis drops them.
      return worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT })
        .then(function () { return worker; });
    });
  }

  /* Two engines, because every picture gets two passes (see brightStencil)
     and running them side by side halves the wait for each one. */
  function getWorkers() {
    if (!workerPromise) {
      var made = [createWorker(), createWorker()];
      workerPromise = Promise.all(made);
      workerPromise.catch(function () {
        workerPromise = null;                 // retry next time
        made.forEach(function (p) {           // and don't strand the one that started
          p.then(function (w) { w.terminate(); }, function () { });
        });
      });
    }
    return workerPromise;
  }

  function begin() {
    busy++;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function end() {
    busy--;
    if (busy > 0 || !workerPromise) return;
    idleTimer = setTimeout(function () {
      var pending = workerPromise;
      workerPromise = null;
      idleTimer = null;
      pending.then(function (workers) {
        return Promise.all(workers.map(function (w) { return w.terminate(); }));
      }).catch(function () { });
    }, IDLE_MS);
  }

  /* Decode whatever the site served (WebP and AVIF included — the engine's own
     decoder only knows the classics) and hand it over as a canvas, upscaled. */
  function prepare(blob) {
    return createImageBitmap(blob).then(function (bitmap) {
      var scale = Math.min(MAX_SCALE, Math.max(1, TARGET_WIDTH / bitmap.width));
      scale = Math.min(scale, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      return canvas;
    });
  }

  /* Captions on memes and thumbnails are usually white or yellow with a dark
     outline, over a busy picture. The engine's own thresholding sees the
     outline and the picture and loses the letters. So there's a second pass
     over a stencil: bright pixels become black ink on a white page, and
     everything else disappears. */
  var BRIGHT = 185;

  function brightStencil(canvas) {
    var out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    var ctx = out.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    var img = ctx.getImageData(0, 0, out.width, out.height);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      var v = luma >= BRIGHT ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  /* Memes put their caption right against the edge of the picture, and
     Tesseract's layout analysis loses text that touches the border — on one
     real meme it read nothing at all, and the same picture with a white
     margin read every word at 96%. So every pass gets a margin. Added after
     the stencil, not before, or the white margin becomes a black frame. */
  var MARGIN = 40;

  function withMargin(canvas) {
    var out = document.createElement('canvas');
    out.width = canvas.width + 2 * MARGIN;
    out.height = canvas.height + 2 * MARGIN;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, MARGIN, MARGIN);
    return out;
  }

  function confidentText(page) {
    var lines = [];
    (page.blocks || []).forEach(function (block) {
      (block.paragraphs || []).forEach(function (para) {
        (para.lines || []).forEach(function (line) {
          var words = (line.words || []).filter(function (w) {
            return w.confidence >= MIN_CONFIDENCE && /[\p{L}\p{N}]/u.test(w.text);
          }).map(function (w) { return w.text; });
          /* A lone one- or two-letter "line" is nearly always a fragment of
             a face or a logo ("UN", "ha", "4d" — real thumbnail reads), and
             blocked words that short, like "AI", are exactly what it would
             hit. Real captions come with company on the line. */
          if (words.length === 1 && words[0].replace(/[^\p{L}\p{N}]/gu, '').length < 3) return;
          if (words.length) lines.push(words.join(' '));
        });
      });
    });
    return lines.join('\n').slice(0, 4000);
  }

  /* Both passes usually read the same caption; keep each line once. */
  function mergeLines(a, b) {
    var seen = Object.create(null);
    return (a + '\n' + b).split('\n').filter(function (line) {
      var key = line.trim().toLowerCase();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    }).join('\n').slice(0, 4000);
  }

  function recognize(blob) {
    begin();
    return Promise.all([getWorkers(), prepare(blob)]).then(function (got) {
      var workers = got[0];
      var canvas = got[1];
      var output = { text: false, blocks: true };
      return Promise.all([
        workers[0].recognize(withMargin(canvas), {}, output),
        workers[1].recognize(withMargin(brightStencil(canvas)), {}, output)
      ]).then(function (passes) {
        return mergeLines(confidentText(passes[0].data), confidentText(passes[1].data));
      });
    }).then(function (text) {
      end();
      return text;
    }, function (err) {
      end();
      throw err;
    });
  }

  function fetchImage(url) {
    return fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var type = res.headers.get('content-type') || '';
        if (type && !/^image\//.test(type)) throw new Error('not an image: ' + type);
        var length = +res.headers.get('content-length') || 0;
        if (length > MAX_BYTES) throw new Error('image too large');
        return res.blob();
      })
      .then(function (blob) {
        if (blob.size > MAX_BYTES) throw new Error('image too large');
        return blob;
      });
  }

  function remember(key, text) {
    cache.delete(key);
    cache.set(key, text);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /* Text in the image at url. Each picture is read once: repeats come from
     the cache, and simultaneous requests share one read. key names the
     picture when one is served under several URLs (WF.ocrImageKey). */
  function read(url, key) {
    key = key || url;
    if (cache.has(key)) {
      var text = cache.get(key);
      remember(key, text);                  // refresh its place
      return Promise.resolve(text);
    }
    if (inflight.has(key)) return inflight.get(key);

    var job = fetchImage(url).then(recognize).then(function (text) {
      inflight.delete(key);
      remember(key, text);
      return text;
    }, function (err) {
      inflight.delete(key);
      throw err;
    });
    inflight.set(key, job);
    return job;
  }

  return {
    read: read,
    recognize: recognize,
    MIN_CONFIDENCE: MIN_CONFIDENCE
  };
})();
