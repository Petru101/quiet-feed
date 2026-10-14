/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — background page. It exists only to read text in images for
   the content scripts (see ocr.js); with that switched off it does nothing. */

(function () {
  'use strict';

  function allowed(origin) {
    if (!origin) return Promise.resolve(false);
    return browser.permissions.contains({ origins: [origin] })
      .catch(function () { return false; });
  }

  /* Allowed at all: any one of the image hosts. Checked host by host, because
     the list grows — someone who switched this on before a host was added
     has the old ones but not the new, and should keep what they have. */
  function anyAllowed() {
    return Promise.all(WF.OCR_ORIGINS.map(allowed)).then(function (each) {
      return each.some(Boolean);
    });
  }

  /* The answer is always an object, never a rejection: a content script that
     gets no text simply treats the image as read-and-empty, so a broken engine
     can only ever fail open — images unblurred, nothing wrongly hidden.

     The permission is checked, not the config. Settings sync between devices
     but a granted permission doesn't, so "on" can arrive on a machine where it
     was never allowed. The content script is told, and stops asking. */
  browser.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;

    if (msg.type === 'wf-ocr-ready') {
      return anyAllowed().then(function (ok) { return { granted: ok }; });
    }

    if (msg.type !== 'wf-ocr') return;

    // Only ever the image hosts the feature is for, whatever is asked.
    var url = WF.ocrImageUrl(msg.url);
    if (!url) return Promise.resolve({ text: '', error: 'not an image this reads' });

    return allowed(WF.ocrOriginFor(url)).then(function (ok) {
      if (!ok) {
        // Just this host (the settings page offers to allow it), or nothing
        // at all any more — only the second stops the content script asking.
        return anyAllowed().then(function (any) {
          return { text: '', error: any ? 'host not allowed' : 'permission' };
        });
      }
      return OCR.read(url, WF.ocrImageKey(url)).then(function (text) {
        return { text: text };
      }, function (err) {
        return { text: '', error: String((err && err.message) || err) };
      });
    });
  });

  /* --------------------------------------------------- automatic backups

     Opt-in. Everything else the extension keeps lives in Firefox's storage
     for it, which Firefox deletes the moment the extension is removed — a
     word list built over months, gone with one wrong click. A file in
     Downloads survives that.

     A few seconds after the list or settings change, the same file Export
     writes goes to Downloads/Quiet Feed backups/, one file per day, so every
     earlier day stays as it was. And a backup never makes things worse:

       - an empty list is never written — it's what a wiped install looks like;
       - today's file is only overwritten by a list at least as long as the one
         it holds. A shorter one goes to a file of its own, stamped with the
         time, so a mass deletion can't take the good copy with it. */

  var BACKUP_DELAY = 4000;
  var backupTimer = null;
  var backupQueue = Promise.resolve();

  function canDownload() {
    if (!browser.downloads) return Promise.resolve(false);
    return browser.permissions.contains({ permissions: ['downloads'] })
      .catch(function () { return false; });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function stamp(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /* What counts as a change: everything in the file except the save time and
     the popup's folded state, which change without anything being edited. */
  function signature(payload) {
    var copy = Object.assign({}, payload);
    delete copy.savedAt;
    delete copy.listCollapsed;
    return JSON.stringify(copy);
  }

  /* Writing a backup is kept out of the download history once it's done, so
     the history isn't a column of identical JSON files. The file stays. */
  function tidy(id, url) {
    function done(delta) {
      if (delta.id !== id || !delta.state || delta.state.current === 'in_progress') return;
      browser.downloads.onChanged.removeListener(done);
      URL.revokeObjectURL(url);
      if (delta.state.current === 'complete') browser.downloads.erase({ id: id }).catch(function () { });
    }
    browser.downloads.onChanged.addListener(done);
  }

  function writeBackup(force) {
    return Promise.all([
      WF.loadConfig(),
      canDownload(),
      browser.storage.local.get(WF.BACKUP_KEY)
    ]).then(function (got) {
      var cfg = got[0];
      var last = (got[2] && got[2][WF.BACKUP_KEY]) || {};
      if (!cfg.autoBackup || !got[1]) return last;

      var payload = WF.backupPayload(cfg);
      var sig = signature(payload);
      if (!force && sig === last.sig) return last;          // nothing new to keep
      if (!cfg.words.length) return last;                   // never save an empty list

      var now = new Date();
      var day = stamp(now);
      var today = last.day === day ? (last.dayWords || 0) : 0;
      var name = 'quiet-feed-' + day;
      if (cfg.words.length < today) {
        name += '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
      }
      var filename = WF.BACKUP_DIR + '/' + name + '.json';

      var url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      return browser.downloads.download({
        url: url,
        filename: filename,
        conflictAction: 'overwrite',
        saveAs: false
      }).then(function (id) {
        tidy(id, url);
        var record = {
          sig: sig,
          at: now.getTime(),
          file: filename,
          words: cfg.words.length,
          day: day,
          dayWords: cfg.words.length >= today ? cfg.words.length : today,
          error: ''
        };
        var patch = {};
        patch[WF.BACKUP_KEY] = record;
        return browser.storage.local.set(patch).then(function () { return record; });
      }, function (err) {
        URL.revokeObjectURL(url);
        var failed = Object.assign({}, last, { error: String((err && err.message) || err), failedAt: now.getTime() });
        var patch = {};
        patch[WF.BACKUP_KEY] = failed;
        return browser.storage.local.set(patch).then(function () { return failed; });
      });
    });
  }

  // One at a time, so two quick changes can't both decide they're "today's".
  function backup(force) {
    var run = backupQueue.then(function () { return writeBackup(force); });
    backupQueue = run.catch(function () { });
    return run;
  }

  browser.storage.onChanged.addListener(function (changes) {
    if (!changes.wfConfig) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(function () { backup(false); }, BACKUP_DELAY);
  });

  // The settings page asks for one straight away when the feature is switched on.
  browser.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'wf-backup-now') return backup(true);
  });
})();
