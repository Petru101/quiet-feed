/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — popup: see the list, add to it, delete from it, and toggle
   which sites it runs on. When the opt-in password is set, everything that
   changes settings is disabled until you unlock. */

(function () {
  'use strict';

  var els = {
    enabled: document.getElementById('enabled'),
    enabledLabel: document.getElementById('enabled-label'),
    lockbar: document.getElementById('lockbar'),
    lockMsg: document.getElementById('lock-msg'),
    unlockForm: document.getElementById('unlock-form'),
    unlockInput: document.getElementById('unlock-input'),
    form: document.getElementById('add-form'),
    input: document.getElementById('add-input'),
    addBtn: document.getElementById('add-btn'),
    warn: document.getElementById('warn'),
    status: document.getElementById('status'),
    sites: Array.prototype.slice.call(document.querySelectorAll('.pill[data-site]')),
    listToggle: document.getElementById('list-toggle'),
    caret: document.getElementById('caret'),
    listCount: document.getElementById('list-count'),
    list: document.getElementById('list'),
    empty: document.getElementById('empty'),
    reveal: document.getElementById('reveal'),
    reportLink: document.getElementById('report-link'),
    options: document.getElementById('options')
  };

  var cfg = WF.normalize(null);
  var stats = null;
  var unlocked = false;

  /* Writes this popup has started that haven't finished. While any are in
     flight, what's in storage is older than what's on screen. */
  var pendingWrites = 0;

  function isLocked() {
    return cfg.lock.enabled && !unlocked;
  }

  function render() {
    var locked = isLocked();

    els.lockbar.hidden = !locked;

    els.enabled.checked = cfg.enabled;
    els.enabledLabel.textContent = cfg.enabled ? 'On' : 'Off';
    els.reveal.checked = cfg.revealAll;

    els.enabled.disabled = locked;
    els.reveal.disabled = locked;
    els.input.disabled = locked;
    els.addBtn.disabled = locked;
    els.input.placeholder = locked ? 'Unlock to add words' : 'Add a word or phrase…';

    els.sites.forEach(function (pill) {
      var on = !!cfg.sites[pill.dataset.site];
      pill.setAttribute('aria-pressed', on ? 'true' : 'false');
      pill.disabled = locked;
      pill.title = (on ? 'Filtering ' : 'Not filtering ') +
        (pill.dataset.name || pill.dataset.site).toLowerCase();
    });

    renderList(locked);
    renderStatus();
  }

  function renderList(locked) {
    var collapsed = cfg.listCollapsed;

    els.listCount.textContent = cfg.words.length
      ? 'Words (' + cfg.words.length + ')'
      : 'Words';
    els.caret.classList.toggle('closed', collapsed);
    els.listToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    els.listToggle.title = collapsed ? 'Show the list' : 'Hide the list';

    els.list.hidden = collapsed;
    els.empty.hidden = collapsed || cfg.words.length > 0;
    if (collapsed) return;

    els.list.textContent = '';

    cfg.words.forEach(function (word) {
      var li = document.createElement('li');
      if (locked) li.className = 'readonly';

      /* Flag entries that can't compile. New ones are refused on entry, but an
         imported list can still carry one. */
      var broken = !WF.isValid(word, cfg.matchMode);
      if (broken) li.classList.add('bad');

      var span = document.createElement('span');
      span.className = 'word';
      span.textContent = word;
      span.title = broken
        ? word + " — not a valid regular expression, so it never matches anything."
        : word;
      li.appendChild(span);

      var hits = stats && stats.counts ? stats.counts[word] : 0;
      if (hits) {
        var badge = document.createElement('span');
        badge.className = 'count';
        badge.textContent = String(hits);
        badge.title = hits + ' hidden on this page';
        li.appendChild(badge);
      }

      if (!locked) {
        var del = document.createElement('button');
        del.type = 'button';
        del.textContent = '×';
        del.title = 'Remove "' + word + '"';
        del.addEventListener('click', function () { removeWord(word); });
        li.appendChild(del);
      }

      els.list.appendChild(li);
    });
  }

  function renderStatus() {
    if (!cfg.enabled) {
      els.status.textContent = 'Filtering is off.';
      return;
    }
    if (!stats) {
      els.status.textContent = cfg.words.length
        ? cfg.words.length + ' word' + (cfg.words.length === 1 ? '' : 's') + ' · not a YouTube or Reddit tab'
        : '';
      return;
    }
    if (!stats.active) {
      els.status.textContent = 'Not filtering ' + stats.site + ' right now.';
      return;
    }
    var verb = cfg.revealAll ? 'marked' : 'hidden';
    els.status.textContent = '';
    var b = document.createElement('b');
    b.textContent = String(stats.total);
    els.status.appendChild(b);
    els.status.appendChild(document.createTextNode(
      ' post' + (stats.total === 1 ? '' : 's') + ' ' + verb + ' on this page'
    ));
  }

  /* Every change is applied to what is stored *now*, never to the copy this
     popup loaded when it opened — otherwise a settings tab that changed the
     list in the meantime would have its change silently overwritten.

     The popup only adopts the stored result once its last pending write has
     landed. Writes run in order and each applies to fresh storage, so the
     final result already carries every change; adopting an earlier one would
     briefly roll back a later change already shown on screen. */
  function update(mutate) {
    pendingWrites++;
    return WF.updateConfig(mutate).then(function (done) {
      pendingWrites--;
      if (pendingWrites === 0) {
        cfg = done.cfg;
        render();
        setTimeout(loadStats, 400);
      }
      return done.result;
    }, function (err) {
      pendingWrites--;
      throw err;
    });
  }

  /* Backstop for anything the disabled attributes don't already block. */
  function guard() {
    if (!isLocked()) return true;
    els.lockMsg.textContent = 'Unlock first to make changes.';
    els.lockMsg.className = 'err';
    els.unlockInput.focus();
    return false;
  }

  function setWarning(message) {
    els.warn.textContent = message || '';
    els.warn.hidden = !message;
  }

  /* Commas separate entries — except inside a regex, where they are part of
     the syntax: splitting `/\d{2,4}/` would produce two pieces of nonsense
     that both look like ordinary words and get added without complaint. */
  function splitEntries(raw) {
    var trimmed = raw.trim();
    if (/^\/.*\/[a-z]*$/.test(trimmed)) return [trimmed];
    return raw.split(',');
  }

  function addWords(raw) {
    if (!guard()) return;
    var toAdd = [];
    var rejected = [];

    splitEntries(raw).forEach(function (part) {
      var word = part.trim();
      if (!word) return;
      if (!WF.isValid(word, cfg.matchMode)) { rejected.push(word); return; }
      toAdd.push(word);
    });

    setWarning(rejected.length === 0 ? '' : rejected.length === 1
      ? '“' + rejected[0] + '” isn’t a valid regular expression, so it wasn’t added.'
      : rejected.length + ' entries aren’t valid regular expressions, so they weren’t added.');

    if (!toAdd.length) return;

    update(function (c) {
      var added = false;
      toAdd.forEach(function (word) {
        var dupe = c.words.some(function (w) { return w.toLowerCase() === word.toLowerCase(); });
        if (dupe) return;
        c.words.push(word);
        added = true;
      });
      if (!added) return;
      c.words.sort(function (a, b) { return a.localeCompare(b); });
      c.listCollapsed = false;                 // show what you just added
    });
  }

  function removeWord(word) {
    if (!guard()) return;
    update(function (c) {
      c.words = c.words.filter(function (w) { return w !== word; });
    });
  }

  function loadStats() {
    return browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      if (!tabs.length) return;
      return browser.tabs.sendMessage(tabs[0].id, { type: 'wf-stats' });
    }).then(function (result) {
      stats = result || null;
      render();
    }).catch(function () {
      stats = null;
      renderStatus();
    });
  }

  /* ------------------------------------------------------------- handlers */

  els.unlockForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var value = els.unlockInput.value;
    els.unlockInput.value = '';
    els.lockMsg.textContent = 'Checking…';
    els.lockMsg.className = '';

    WF.verifyPassword(value, cfg.lock).then(function (ok) {
      if (!ok) {
        els.lockMsg.textContent = 'Wrong password.';
        els.lockMsg.className = 'err';
        els.unlockInput.focus();
        return;
      }
      unlocked = true;
      els.lockMsg.textContent = 'Locked. Enter your password to make changes.';
      els.lockMsg.className = '';
      return WF.setUnlocked().then(function () {
        render();
        els.input.focus();
      });
    });
  });

  els.form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var value = els.input.value;
    els.input.value = '';
    els.input.focus();
    addWords(value);
  });

  /* Toggles write the state the user asked for — the opposite of what the
     control showed when clicked — rather than flipping whatever is stored,
     which could have changed underneath and would then flip the wrong way.

     They also show the change straight away and persist it after. Waiting on
     storage first made a toggle feel laggy, and a quick second click read the
     old state and flipped the same way twice. */

  function toggle(apply) {
    apply(cfg);
    render();
    return update(apply);
  }

  els.listToggle.addEventListener('click', function () {
    var target = !cfg.listCollapsed;
    toggle(function (c) { c.listCollapsed = target; });   // display-only, allowed while locked
  });

  els.sites.forEach(function (pill) {
    pill.addEventListener('click', function () {
      if (!guard()) return;
      var site = pill.dataset.site;
      var target = !cfg.sites[site];
      toggle(function (c) { c.sites[site] = target; });
    });
  });

  els.enabled.addEventListener('change', function () {
    if (!guard()) { els.enabled.checked = cfg.enabled; return; }
    var target = els.enabled.checked;
    toggle(function (c) { c.enabled = target; });
  });

  els.reveal.addEventListener('change', function () {
    if (!guard()) { els.reveal.checked = cfg.revealAll; return; }
    var target = els.reveal.checked;
    toggle(function (c) { c.revealAll = target; });
  });

  els.options.addEventListener('click', function (ev) {
    ev.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  });

  /* Straight to the report section, since someone clicking this has just hit
     the problem and shouldn't have to go hunting for where to say so. */
  els.reportLink.addEventListener('click', function (ev) {
    ev.preventDefault();
    browser.tabs.create({ url: browser.runtime.getURL('src/options.html#report') });
    window.close();
  });

  /* Another window changed the settings while this popup is open. Re-read
     rather than trusting the event's value, so the newer of the sync and local
     copies wins. Skipped while this popup's own writes are still landing —
     their completion adopts the stored state anyway, and adopting an
     in-between copy now would undo a change already shown. */
  browser.storage.onChanged.addListener(function (changes) {
    if (!changes.wfConfig || pendingWrites > 0) return;
    WF.loadConfig().then(function (fresh) {
      if (pendingWrites > 0) return;
      cfg = fresh;
      render();
    });
  });

  /* ----------------------------------------------------------------- boot */

  Promise.all([WF.loadConfig(), WF.isUnlocked()]).then(function (results) {
    cfg = results[0];
    unlocked = results[1];
    render();
    if (isLocked()) els.unlockInput.focus();
    else els.input.focus();
    loadStats();
  });
})();
