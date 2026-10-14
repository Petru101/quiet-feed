/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — settings page. */

(function () {
  'use strict';

  var cfg = WF.normalize(null);
  var unlocked = false;

  /* The list as it was when the textarea was last filled from storage. Saving
     merges this page's edits against it, so words another window added in the
     meantime are kept instead of being overwritten. */
  var wordsBaseline = [];

  var SITE_KEYS = ['youtubeVideos', 'youtubeComments', 'redditPosts', 'redditComments', 'x'];

  var wordsBox = document.getElementById('words');
  var savedWords = document.getElementById('saved-words');
  var savedIo = document.getElementById('saved-io');
  var savedPw = document.getElementById('saved-pw');
  var importFile = document.getElementById('import-file');
  var lockbar = document.getElementById('lockbar');
  var lockMsg = document.getElementById('lock-msg');

  function isLocked() {
    return cfg.lock.enabled && !unlocked;
  }

  function flash(el, text, cls) {
    el.textContent = text || 'Saved';
    el.className = 'saved show' + (cls ? ' ' + cls : '');
    setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function radio(name, value) {
    document.querySelectorAll('input[name="' + name + '"]').forEach(function (input) {
      input.checked = input.value === value;
    });
  }

  function parseWords(text) {
    var seen = Object.create(null);
    return text.split('\n').map(function (line) {
      return line.trim();
    }).filter(function (word) {
      if (!word) return false;
      var key = word.toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function sameList(a, b) {
    return a.join('\n') === b.join('\n');
  }

  /* True while the textarea holds edits that haven't been saved yet. */
  function isDirty() {
    return !sameList(parseWords(wordsBox.value), wordsBaseline);
  }

  /* Refreshes every control from cfg. The textarea is the exception: it is only
     overwritten when forced, or when it holds no unsaved edits — a change made
     in another window must never wipe out what someone is part-way through
     typing here. */
  function render(opts) {
    if ((opts && opts.words) || !isDirty()) {
      wordsBox.value = cfg.words.join('\n');
      wordsBaseline = cfg.words.slice();
    }
    radio('hideMode', cfg.hideMode);
    radio('matchMode', cfg.matchMode);
    document.getElementById('showLabel').checked = cfg.showLabel;
    document.getElementById('killMedia').checked = cfg.killMedia;
    document.getElementById('ocrBlur').checked = cfg.ocrBlur;
    renderOcr();
    renderBackup();
    SITE_KEYS.forEach(function (key) {
      document.getElementById('site-' + key).checked = !!cfg.sites[key];
    });
    refreshReport();
    applyLock();
  }

  /* Everything outside the unlock bar goes read-only while locked. */
  function applyLock() {
    var locked = isLocked();

    lockbar.hidden = !locked;

    document.querySelectorAll('input, textarea, button').forEach(function (el) {
      // Reporting a bug isn't changing a setting — the lock shouldn't block it.
      if (el.closest('#lockbar') || el.closest('#report')) return;
      el.disabled = locked;
    });

    document.getElementById('pw-off').hidden = cfg.lock.enabled;
    document.getElementById('pw-on').hidden = !cfg.lock.enabled;
    if (!cfg.lock.enabled) document.getElementById('pw-change-row').hidden = true;
  }

  /* Every change is applied to what is in storage *now*, not to the copy this
     page loaded when it opened. Writing that stale copy back is how an open
     settings tab used to erase words added from the popup in the meantime. */
  function forceUpdate(mutate) {
    return WF.updateConfig(mutate).then(function (done) {
      cfg = done.cfg;
      render();
      return done.result;
    });
  }

  function update(mutate) {
    if (isLocked()) return Promise.resolve(null);
    return forceUpdate(mutate);
  }

  /* --------------------------------------------------------------- unlock */

  document.getElementById('unlock-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = document.getElementById('unlock-input');
    var value = input.value;
    input.value = '';
    lockMsg.textContent = 'Checking…';
    lockMsg.className = 'hint';

    WF.verifyPassword(value, cfg.lock).then(function (ok) {
      if (!ok) {
        lockMsg.textContent = 'Wrong password.';
        lockMsg.className = 'hint err';
        input.focus();
        return;
      }
      unlocked = true;
      lockMsg.textContent = 'Enter your password to make changes. Everything stays readable.';
      lockMsg.className = 'hint';
      return WF.setUnlocked().then(applyLock);
    });
  });

  /* ------------------------------------------------------------- password */

  function readPair(aId, bId) {
    var a = document.getElementById(aId).value;
    var b = document.getElementById(bId).value;
    if (a.length < 4) return { error: 'Use at least 4 characters.' };
    if (a !== b) return { error: "The two passwords don't match." };
    return { password: a };
  }

  function clearFields(ids) {
    ids.forEach(function (id) { document.getElementById(id).value = ''; });
  }

  // The password flows bypass the lock gate: they are the lock changing.

  document.getElementById('pw-enable').addEventListener('click', function () {
    var pair = readPair('pw-new', 'pw-confirm');
    if (pair.error) { flash(savedPw, pair.error, 'err'); return; }

    WF.makeLock(pair.password).then(function (lock) {
      unlocked = true;                       // you just set it; don't lock yourself out
      return forceUpdate(function (c) { c.lock = lock; });
    }).then(function () {
      return WF.setUnlocked();
    }).then(function () {
      clearFields(['pw-new', 'pw-confirm']);
      applyLock();
      flash(savedPw, 'Protection is on.');
    }).catch(function () {
      flash(savedPw, "Couldn't set the password.", 'err');
    });
  });

  document.getElementById('pw-disable').addEventListener('click', function () {
    forceUpdate(function (c) {
      c.lock = { enabled: false, salt: '', hash: '', iterations: WF.DEFAULTS.lock.iterations };
    }).then(function () {
      return WF.relock();
    }).then(function () {
      unlocked = false;
      applyLock();
      flash(savedPw, 'Protection is off.');
    });
  });

  document.getElementById('pw-change').addEventListener('click', function () {
    var row = document.getElementById('pw-change-row');
    row.hidden = !row.hidden;
    if (!row.hidden) document.getElementById('pw-new2').focus();
  });

  document.getElementById('pw-change-save').addEventListener('click', function () {
    var pair = readPair('pw-new2', 'pw-confirm2');
    if (pair.error) { flash(savedPw, pair.error, 'err'); return; }

    WF.makeLock(pair.password).then(function (lock) {
      return forceUpdate(function (c) { c.lock = lock; });
    }).then(function () {
      return WF.setUnlocked();
    }).then(function () {
      clearFields(['pw-new2', 'pw-confirm2']);
      document.getElementById('pw-change-row').hidden = true;
      flash(savedPw, 'Password changed.');
    }).catch(function () {
      flash(savedPw, "Couldn't change the password.", 'err');
    });
  });

  document.getElementById('pw-relock').addEventListener('click', function () {
    WF.relock().then(function () {
      unlocked = false;
      applyLock();
      flash(savedPw, 'Locked.');
    });
  });

  /* --------------------------------------------------------------- fields */

  /* A bulk save is a three-way merge rather than a straight overwrite: what
     this page loaded, what was typed here, and what is stored now. Words
     added or removed here are applied; words another window added meanwhile
     survive. */
  document.getElementById('save-words').addEventListener('click', function () {
    if (isLocked()) return;

    var mine = parseWords(wordsBox.value);
    var base = wordsBaseline.slice();
    var mergedElsewhere = false;

    forceUpdate(function (c) {
      mergedElsewhere = !sameList(c.words, base);
      c.words = WF.mergeWords(base, mine, c.words);
    }).then(function (result) {
      render({ words: true });

      /* Bulk editing keeps a broken entry rather than dropping it silently —
         it's usually a typo the user wants to fix, not something to discard. */
      var broken = WF.invalidWords(cfg.words, cfg.matchMode);
      var message = 'Saved ' + cfg.words.length + ' word' + (cfg.words.length === 1 ? '' : 's');
      var problem = false;

      if (mergedElsewhere) {
        message += ', merged with changes made in another window';
      }
      if (result && result.area === 'local') {
        message += ' — kept on this device only, Firefox Sync wouldn’t take it';
        problem = true;
      }
      if (broken.length) {
        message += ' — but ' + (broken.length === 1
          ? '“' + broken[0] + '” isn’t a valid regular expression and will never match'
          : broken.length + ' entries aren’t valid regular expressions and will never match');
        problem = true;
      }

      flash(savedWords, message, problem ? 'err' : '');
    });
  });

  document.querySelectorAll('input[name="hideMode"]').forEach(function (input) {
    input.addEventListener('change', function () {
      if (!input.checked) return;
      var value = input.value;
      update(function (c) { c.hideMode = value; });
    });
  });

  document.querySelectorAll('input[name="matchMode"]').forEach(function (input) {
    input.addEventListener('change', function () {
      if (!input.checked) return;
      var value = input.value;
      update(function (c) { c.matchMode = value; });
    });
  });

  document.getElementById('showLabel').addEventListener('change', function (ev) {
    var on = ev.target.checked;
    update(function (c) { c.showLabel = on; });
  });

  document.getElementById('killMedia').addEventListener('change', function (ev) {
    var on = ev.target.checked;
    update(function (c) { c.killMedia = on; });
  });

  /* ------------------------------------------------------ text in images

     The setting syncs between devices; Firefox's permission to load the
     image hosts doesn't. So the box shows whether it's actually working
     here — on *and* allowed — and ticking it asks for the permission. */

  var savedOcr = document.getElementById('saved-ocr');

  /* Which of the image hosts Firefox allows, one by one: the list grows with
     updates, and Firefox never grants a newly added host by itself. */
  function imageAccess() {
    if (!browser.permissions) return Promise.resolve({ any: false, all: false });
    return Promise.all(WF.OCR_ORIGINS.map(function (origin) {
      return browser.permissions.contains({ origins: [origin] })
        .catch(function () { return false; });
    })).then(function (each) {
      return { any: each.some(Boolean), all: each.every(Boolean) };
    });
  }

  function renderOcr() {
    return imageAccess().then(function (access) {
      document.getElementById('ocr').checked = !!(cfg.ocr && access.any);
      document.getElementById('ocr-more').hidden = !(cfg.ocr && access.any && !access.all);
    });
  }

  document.getElementById('ocr-allow').addEventListener('click', function () {
    // First thing in the handler, or Firefox won't show the prompt.
    browser.permissions.request({ origins: WF.OCR_ORIGINS }).then(function (ok) {
      flash(savedOcr, ok ? 'Allowed. Those pictures are read too now.' : 'Not allowed; those pictures stay unread.', ok ? '' : 'err');
      return renderOcr();
    }).catch(function () {
      flash(savedOcr, "Couldn't ask Firefox for the permission.", 'err');
    });
  });

  document.getElementById('ocr').addEventListener('change', function (ev) {
    var box = ev.target;
    if (isLocked()) return;

    if (!box.checked) {
      update(function (c) { c.ocr = false; }).then(function () {
        // Nothing needs the access any more; hand it back.
        if (browser.permissions) browser.permissions.remove({ origins: WF.OCR_ORIGINS }).catch(function () { });
        flash(savedOcr, 'Off. Pictures are no longer read.');
      });
      return;
    }

    /* Firefox only shows the permission prompt in direct response to a
       click, so this has to be the very first thing the handler does. */
    browser.permissions.request({ origins: WF.OCR_ORIGINS }).then(function (ok) {
      if (!ok) {
        box.checked = false;
        flash(savedOcr, 'Not turned on: reading pictures needs that permission.', 'err');
        return;
      }
      return update(function (c) { c.ocr = true; }).then(function () {
        flash(savedOcr, 'On. Pictures in posts are read against your list.');
      });
    }).catch(function () {
      box.checked = false;
      flash(savedOcr, "Couldn't ask Firefox for the permission.", 'err');
    });
  });

  document.getElementById('ocrBlur').addEventListener('change', function (ev) {
    var on = ev.target.checked;
    update(function (c) { c.ocrBlur = on; });
  });

  SITE_KEYS.forEach(function (key) {
    document.getElementById('site-' + key).addEventListener('change', function (ev) {
      var on = ev.target.checked;
      update(function (c) { c.sites[key] = on; });
    });
  });

  /* --------------------------------------------------------------- report

     Deliberately excludes the word list. What people choose to filter is often
     personal — health, names, politics — and a bug report shouldn't quietly
     carry it to a stranger's inbox. Counts and settings are what's diagnostic
     anyway, and the text is shown in full before anything is sent. */

  var REPORT_ADDRESS = 'petru@email.com';

  function buildReport() {
    var m = browser.runtime.getManifest();
    var broken = WF.invalidWords(cfg.words, cfg.matchMode).length;

    return [
      'What went wrong?',
      '',
      '',
      'Which page were you on? (for example: YouTube home, a Reddit thread, an X profile)',
      '',
      '',
      '--- the lines below help me debug; your word list is not included ---',
      m.name + ' ' + m.version,
      navigator.userAgent,
      'Sites: ' + SITE_KEYS.map(function (k) {
        return k + '=' + (cfg.sites[k] ? 'on' : 'off');
      }).join(' '),
      'Hide: ' + cfg.hideMode +
      ' | Match: ' + cfg.matchMode +
      ' | Silence video: ' + (cfg.killMedia ? 'on' : 'off') +
      ' | Image text: ' + (cfg.ocr ? 'on' + (cfg.ocrBlur ? ', blur' : '') : 'off') +
      ' | Auto-backup: ' + (cfg.autoBackup ? 'on' : 'off') +
      ' | Preview mode: ' + (cfg.revealAll ? 'on' : 'off') +
      ' | Locked: ' + (cfg.lock.enabled ? 'yes' : 'no'),
      'Words: ' + cfg.words.length + (broken ? ' (' + broken + ' invalid)' : '')
    ].join('\n');
  }

  function mailtoUrl() {
    return 'mailto:' + REPORT_ADDRESS +
      '?subject=' + encodeURIComponent('Quiet Feed bug report') +
      '&body=' + encodeURIComponent(buildReport());
  }

  function refreshReport() {
    document.getElementById('report-text').value = buildReport();
    document.getElementById('report-address').href = mailtoUrl();
  }

  document.getElementById('report-open').addEventListener('click', function () {
    var a = document.createElement('a');
    a.href = mailtoUrl();
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  document.getElementById('report-copy').addEventListener('click', function () {
    var text = buildReport();
    var done = function () { flash(document.getElementById('saved-report'), 'Copied.'); };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(selectInstead);
    } else {
      selectInstead();
    }

    function selectInstead() {
      var box = document.getElementById('report-text');
      box.focus();
      box.select();
      flash(document.getElementById('saved-report'), 'Selected — press Ctrl+C to copy.');
    }
  });

  /* --------------------------------------------------------------- backup */

  document.getElementById('export').addEventListener('click', function () {
    var payload = WF.backupPayload(cfg);
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'quiet-feed-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  });

  /* Automatic backups (the writing is in background.js). Like reading images,
     the setting is shown as on only when this device has also allowed it. */

  var savedBackup = document.getElementById('saved-backup');
  var backupStatus = document.getElementById('backup-status');

  function canDownload() {
    if (!browser.permissions || !browser.downloads) return Promise.resolve(false);
    return browser.permissions.contains({ permissions: ['downloads'] })
      .catch(function () { return false; });
  }

  function renderBackup() {
    return Promise.all([
      canDownload(),
      browser.storage.local.get(WF.BACKUP_KEY).catch(function () { return {}; })
    ]).then(function (got) {
      var on = !!(cfg.autoBackup && got[0]);
      var last = (got[1] && got[1][WF.BACKUP_KEY]) || null;
      document.getElementById('autoBackup').checked = on;

      backupStatus.hidden = !on;
      backupStatus.className = 'hint';
      if (!on) return;
      if (last && last.error) {
        backupStatus.className = 'hint err';
        backupStatus.textContent = 'The last backup failed: ' + last.error;
      } else if (last && last.at) {
        backupStatus.textContent = 'Last backup ' + new Date(last.at).toLocaleString() + ', ' +
          last.words + ' word' + (last.words === 1 ? '' : 's') + ' → Downloads/' + last.file;
      } else {
        backupStatus.textContent = 'No backup yet — one is made after your next change, as long as the list isn\'t empty.';
      }
    });
  }

  document.getElementById('autoBackup').addEventListener('change', function (ev) {
    var box = ev.target;
    if (isLocked()) return;

    if (!box.checked) {
      update(function (c) { c.autoBackup = false; }).then(function () {
        if (browser.permissions) browser.permissions.remove({ permissions: ['downloads'] }).catch(function () { });
        flash(savedBackup, 'Off. Backups already saved stay in Downloads.');
        return renderBackup();
      });
      return;
    }

    // First thing in the handler, or Firefox won't show the prompt.
    browser.permissions.request({ permissions: ['downloads'] }).then(function (ok) {
      if (!ok) {
        box.checked = false;
        flash(savedBackup, 'Not turned on: saving backups needs that permission.', 'err');
        return;
      }
      return update(function (c) { c.autoBackup = true; }).then(function () {
        return browser.runtime.sendMessage({ type: 'wf-backup-now' });
      }).then(function () {
        flash(savedBackup, 'On.');
        return renderBackup();
      });
    }).catch(function () {
      box.checked = false;
      flash(savedBackup, "Couldn't turn on backups.", 'err');
    });
  });

  document.getElementById('import').addEventListener('click', function () {
    importFile.click();
  });

  /* An import is a deliberate replacement of the list and settings — but it is
     still applied to fresh storage, so it can't carry a stale lock back. */
  importFile.addEventListener('change', function () {
    var file = importFile.files && importFile.files[0];
    if (!file) return;
    file.text().then(function (text) {
      var incoming = WF.normalize(JSON.parse(text));
      return update(function (c) {
        Object.keys(incoming).forEach(function (key) {
          // Never let a file change your lock, or switch on writing to Downloads.
          if (key !== 'lock' && key !== 'autoBackup') c[key] = incoming[key];
        });
      });
    }).then(function () {
      render({ words: true });
      flash(savedIo, 'Imported ' + cfg.words.length + ' words');
    }).catch(function () {
      flash(savedIo, "That file isn't a valid export.", 'err');
    });
    importFile.value = '';
  });

  /* ------------------------------------------------------ other windows

     The popup, or a second settings tab, changed something. Re-read rather
     than trusting the event's value, so the newer of the sync and local copies
     wins, then refresh — without touching unsaved edits in the textarea. */
  browser.storage.onChanged.addListener(function (changes) {
    if (changes[WF.BACKUP_KEY]) renderBackup();         // a backup was just written
    if (!changes.wfConfig) return;
    WF.loadConfig().then(function (fresh) {
      cfg = fresh;
      render();
    });
  });

  /* ----------------------------------------------------------------- boot */

  Promise.all([WF.loadConfig(), WF.isUnlocked()]).then(function (results) {
    cfg = results[0];
    unlocked = results[1];
    render({ words: true });
    if (isLocked()) document.getElementById('unlock-input').focus();

    // Opened straight from the popup's "Report a bug" link.
    if (location.hash === '#report') {
      document.getElementById('report').scrollIntoView({ block: 'start' });
    }
  });
})();
