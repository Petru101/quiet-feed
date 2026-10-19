/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — content script.

   Two jobs, kept deliberately separate:

   1. HIDE the matching post without removing it. The element stays in the DOM
      and keeps its layout box (visibility:hidden + a pinned min-height), so
      YouTube's infinite scroll doesn't see the page get shorter and start
      loading replacement content in a loop.

   2. SILENCE it. Hiding a post does not stop a <video> inside it, so any media
      in a hidden post is replaced by an invisible spacer of identical size.
      Reddit keeps its <video> inside an open shadow root, so the walker has to
      descend shadowRoot as well as the light DOM. */

(function () {
  'use strict';

  var SITE = WF.detectSite(location.hostname);
  if (!SITE) return;

  var MEDIA_SEL = WF.MEDIA[SITE];
  var postTags = [];             // post selectors that are bare tag names
  var unseenSel = '';            // the rest, for posts not yet decided; both rebuilt with the site toggles

  var cfg = WF.normalize(null);
  var patterns = [];
  var active = false;
  var version = 0;               // bumped on config change to invalidate caches
  var hidden = new Set();        // posts we've hidden, for media re-sweeps
  var seen = new WeakMap();      // element -> {v, text} of text we already tested
  var decided = new WeakMap();   // element -> {text, missSince} when its state was set
  var readAt = new WeakMap();    // post -> {v, due} when its text was last read; dropped when anything in it changes
  var sweeps = 0;                // backstop ticks so far
  var postSel = '';              // every post selector currently switched on

  /* Text in images, when switched on. Image text is keyed by the img's src
     attribute — not currentSrc, which changes once a srcset candidate loads
     and would make a hidden post's text appear to change under it — passed
     through WF.ocrImageKey, so one picture served at two URLs is read once. */
  var IMG_SEL = WF.OCR_IMAGES.map(function (p) { return 'img[src^="' + p + '"]'; }).join(',');
  var PICTURE_SEL = IMG_SEL + ', .wf-spacer[data-wf-src]';   // see spacerFor
  var ocrOn = false;             // reading images on this page right now
  var ocrGranted = false;        // the background says Firefox allowed the image hosts
  var ocrText = new Map();       // image key -> text read from it ('' for none), oldest first
  var ocrAsked = new Set();      // image keys currently being read
  var OCR_INFLIGHT = 2;          // reads outstanding at once; the next is picked by position
  var OCR_AHEAD = 1.5;           // read this many screens below and above the viewport
  var OCR_TIMEOUT = 30000;
  var OCR_KEEP = 5000;

  /* ---------------------------------------------------------------- media */

  function deepQueryAll(root, selector, out) {
    out = out || [];
    try {
      root.querySelectorAll(selector).forEach(function (el) { out.push(el); });
      root.querySelectorAll('*').forEach(function (el) {
        if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
      });
    } catch (e) { /* detached or hostile node */ }
    return out;
  }

  /* Same-size stand-in, measured while the original is still in the document.

     It also keeps the pictures the original held. Reddit puts a GIF or
     video's picture inside its player, so tearing the player out took the
     only place its text could be found: the next time posts were decided
     again — a word added, the extension switched off and on — a post hidden
     for a word in its picture came back, with an empty black player. */
  function spacerFor(el) {
    var rect = el.getBoundingClientRect();
    var d = document.createElement('div');
    d.className = 'wf-spacer';
    if (rect.height > 0) d.style.height = Math.round(rect.height) + 'px';
    if (rect.width > 0) d.style.width = Math.round(rect.width) + 'px';

    var srcs = [];
    deepQueryAll(el, PICTURE_SEL).forEach(function (n) {
      picturesOf(n).forEach(function (src) {
        if (srcs.indexOf(src) === -1) srcs.push(src);
      });
    });
    if (srcs.length) d.dataset.wfSrc = srcs.join(' ');
    return d;
  }

  /* The picture URLs a PICTURE_SEL match stands for. A spacer's are
     space-separated: WF.ocrImageUrl never passes a URL with a space in it. */
  function picturesOf(n) {
    if (n.tagName === 'IMG') return [n.getAttribute('src')];
    return n.getAttribute('data-wf-src').split(' ').filter(WF.ocrImageUrl);
  }

  function hasMedia(el) {
    try { return !!el.querySelector(MEDIA_SEL); } catch (e) { return false; }
  }

  function killMedia(container) {
    if (!cfg.killMedia) return;

    deepQueryAll(container, 'video, audio').forEach(function (m) {
      try {
        m.pause();
        m.muted = true;
        m.volume = 0;
        m.autoplay = false;
        m.removeAttribute('autoplay');
        m.removeAttribute('src');
        m.querySelectorAll('source').forEach(function (s) { s.remove(); });
        m.load();
      } catch (e) { /* ignore */ }
      try { m.replaceWith(spacerFor(m)); } catch (e) { /* ignore */ }
    });

    /* Player wrappers and embeds: dropping the whole element is what actually
       guarantees silence, since a wrapper can re-create its own <video>. */
    deepQueryAll(container, MEDIA_SEL).forEach(function (el) {
      if (!el.isConnected) return;
      try { el.replaceWith(spacerFor(el)); } catch (e) { /* ignore */ }
    });
  }

  /* Posts we've already hidden are skipped by scan(), so they need their own
     upkeep: a site re-rendering a post's children can drop our placeholder, and
     Reddit can re-attach a player inside a post that is already hidden. */
  function maintainHidden() {
    hidden.forEach(function (el) {
      if (!el.isConnected) { hidden.delete(el); return; }
      if (hasMedia(el)) killMedia(el);
      if (cfg.hideMode !== 'collapse') addVeil(el, el.dataset.wfWord || '');
    });
  }

  /* ----------------------------------------------------------- hide/reveal */

  /* min-height applies to the content box unless the element opts into
     border-box, so subtract the frame or the post grows by its own padding. */
  function pinnableHeight(el) {
    var height = el.getBoundingClientRect().height;
    if (height <= 0) return 0;

    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return height; }
    if (cs.boxSizing === 'border-box') return height;

    var frame = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) +
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return isNaN(frame) ? height : Math.max(0, height - frame);
  }

  function hide(el, word) {
    var height = pinnableHeight(el);

    el.dataset.wfState = 'hidden';
    el.dataset.wfWord = word;
    setWhere(el, word);

    if (cfg.hideMode === 'collapse') {
      el.dataset.wfMode = 'collapse';
    } else {
      if (height > 24) el.style.setProperty('min-height', Math.round(height) + 'px', 'important');
      addVeil(el, word);
    }

    hidden.add(el);
    killMedia(el);
    remember(el);                // after killMedia, so our own edits aren't a "change"
  }

  /* verb and onShow are for Shorts, which are skipped rather than hidden in
     place and revealed differently; a post leaves both out. */
  function addVeil(el, word, verb, onShow) {
    try { if (el.querySelector(':scope > .wf-veil')) return; } catch (e) { return; }

    verb = verb || 'Hidden';
    var veil = document.createElement('div');
    veil.className = 'wf-veil';

    var label = document.createElement('span');
    label.className = 'wf-veil-label';
    label.textContent = cfg.showLabel && word
      ? verb + ' · “' + word + '”' + (el.dataset.wfWhere === 'image' ? ' in an image' : '')
      : verb;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wf-veil-btn';
    btn.textContent = 'Show';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      (onShow || reveal)(el);
    }, true);

    veil.appendChild(label);
    veil.appendChild(btn);
    el.appendChild(veil);
  }

  /* Reveal is per-post and sticky: 'revealed' is still a data-wf-state, so the
     element no longer matches unseenSel and won't be re-hidden. */
  function reveal(el) {
    el.dataset.wfState = 'revealed';
    el.removeAttribute('data-wf-mode');
    el.style.removeProperty('min-height');
    try {
      el.querySelectorAll(':scope > .wf-veil').forEach(function (v) { v.remove(); });
    } catch (e) { /* ignore */ }
    // Asked to see it: don't leave its pictures blurred waiting to be read.
    markRead(el);
    hidden.delete(el);
    remember(el);
  }

  function mark(el, word) {
    el.dataset.wfState = 'marked';
    el.dataset.wfWord = word;
    setWhere(el, word);
    remember(el);
  }

  /* Whether the word was only found in a picture. Worth saying on the
     placeholder: otherwise a post whose visible text is innocent looks like
     it was hidden by mistake. */
  function setWhere(el, word) {
    var inImage = false;
    if (ocrOn) {
      var re = null;
      for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].word === word) { re = patterns[i].re; break; }
      }
      if (re) {
        re.lastIndex = 0;
        inImage = !re.test(WF.fold(textOf(el, true)));
      }
    }
    if (inImage) el.dataset.wfWhere = 'image';
    else el.removeAttribute('data-wf-where');
  }

  /* ------------------------------------------------------------- recycling

     A decision is about the content, but the state lives on the element, and
     sites reuse elements: YouTube's grid re-stamps the same renderer with a
     different video when you switch a chip or navigate, and X's virtual list
     moves a cell to a different post as you scroll. Left alone, an innocent
     video inherits the hidden state of whatever used to sit in that slot, and
     only Preview (which re-tests everything) shows it was never a match.

     So every decided element keeps the text it was decided on, and a change
     gets it re-tested. A miss isn't acted on straight away: a re-render can
     briefly show a post half-built, and unhiding then would flash exactly
     what was meant to stay hidden. It has to persist for SETTLE_MS. */
  var SETTLE_MS = 350;

  function remember(el) {
    decided.set(el, { text: textOf(el), missSince: 0 });
    noteRead(el);
  }

  /* A post's text is read again when something in it changes, and also
     every 5-13s regardless, as cheap insurance: whatever else goes wrong
     with render timing, a matching post can never stay visible for good.
     The random spread keeps a long feed from coming due all at once. */
  function noteRead(el) {
    readAt.set(el, { v: version, due: sweeps + 4 + Math.floor(Math.random() * 8) });
  }

  function isFresh(el) {
    var r = readAt.get(el);
    return !!r && r.v === version && sweeps < r.due;
  }

  function forget(el) {
    el.removeAttribute('data-wf-state');
    el.removeAttribute('data-wf-word');
    el.removeAttribute('data-wf-where');
    el.removeAttribute('data-wf-mode');
    el.style.removeProperty('min-height');
    try {
      el.querySelectorAll(':scope > .wf-veil').forEach(function (v) { v.remove(); });
    } catch (e) { /* ignore */ }
    hidden.delete(el);
    decided.delete(el);
    readAt.delete(el);
    seen.delete(el);             // no longer matches unseenSel's :not(), so scan re-tests it
  }

  function relabel(el, word) {
    el.dataset.wfWord = word;
    setWhere(el, word);
    if (el.dataset.wfState !== 'hidden' || cfg.hideMode === 'collapse') return;
    try {
      el.querySelectorAll(':scope > .wf-veil').forEach(function (v) { v.remove(); });
    } catch (e) { /* ignore */ }
    addVeil(el, word);
  }

  function recheck() {
    document.querySelectorAll('[data-wf-state]').forEach(function (el) {
      var rec = decided.get(el);
      if (!rec) { remember(el); return; }
      if (isFresh(el) && !rec.missSince) return;          // nothing in it has changed

      var text = textOf(el);
      noteRead(el);
      if (text.length < 2) return;                       // mid re-render
      if (text === rec.text && !rec.missSince) return;
      rec.text = text;

      var word = firstMatch(text);
      var state = el.dataset.wfState;
      // A revealed post stays revealed while it's the same post; a different
      // word means different content, which deserves its own decision.
      if (word && !(state === 'revealed' && word !== el.dataset.wfWord)) {
        rec.missSince = 0;
        if (word !== el.dataset.wfWord) relabel(el, word);
        return;
      }

      var now = Date.now();
      if (!rec.missSince) {
        rec.missSince = now;
        setTimeout(schedule, SETTLE_MS + 50);            // come back to confirm
      } else if (now - rec.missSince >= SETTLE_MS) {
        forget(el);
      }
    });
  }

  function unhideAll() {
    document.querySelectorAll('[data-wf-state]').forEach(function (el) {
      el.removeAttribute('data-wf-state');
      el.removeAttribute('data-wf-word');
      el.removeAttribute('data-wf-where');
      el.removeAttribute('data-wf-mode');
      el.style.removeProperty('min-height');
      try {
        el.querySelectorAll(':scope > .wf-veil').forEach(function (v) { v.remove(); });
      } catch (e) { /* ignore */ }
    });
    hidden.clear();
    resetShorts();
    version++;
  }

  /* -------------------------------------------------------------- matching */

  /* Read the visible text AND the attributes that carry it. YouTube's newer
     lockup cards keep the title on title/aria-label and render the visible
     text as an "attributed string" that can populate late, so textContent
     alone can miss a title that is plainly there in the markup. */
  /* Timestamps are metadata, not what a post says. Their hover text is a full
     date — Reddit's reads "Thursday, September 11, 2026 at 3:04 PM" — so
     reading them meant blocking a date hid every post published on it. */
  var TIMESTAMP_SEL = 'time, faceplate-timeago';

  /* A video player's own chrome — its buttons, and the captions it draws over
     the picture as it plays — isn't what the post says. The Shorts player sits
     inside the Short it plays, and its captions change every second. */
  var PLAYER_SEL = 'ytd-player, player-component, .ytp-caption-window-container';

  /* What you type isn't what a post says. A reply box sits inside the
     comment it answers, so reading it hid a thread for a word being typed. */
  var EDITOR_SEL = '[contenteditable]:not([contenteditable="false"]), textarea, input';

  /* Our own placeholder sits inside the post and names the word it matched,
     so reading it would make every hidden post match itself forever. */
  var OURS_SEL = '.wf-veil';

  /* Nor is a hover card's popup — the card Reddit shows over a user or
     community name. Signed in, Reddit renders those cards into every post
     ahead of time, so a badge reading "NFL" in one hid a post about a sloth
     bear. Only the popup is skipped: the name it hangs off sits in the
     card's default slot and is still read, so blocking a community by name
     keeps working. */
  var POPUP_SEL = ':is(rpl-hovercard, faceplate-hovercard) > [slot="content"]';

  /* Nor is a community's status, the emoji Reddit shows by its name on every
     post from it. Its button is labelled with the status itself:
     r/nextfuckinglevel's reads "Community status: NFL", so blocking NFL hid
     every post from there. The popup it opens is already skipped above. */
  var STATUS_SEL = '[data-testid^="community-status"]';

  /* Nor is the link a Short carries to a different Short, under its title.
     It names that other Short, so a word in its title hid this one. */
  var LINKED_SEL = 'yt-reel-carousel-view-model';

  var SKIP_SEL = [TIMESTAMP_SEL, PLAYER_SEL, EDITOR_SEL, OURS_SEL, POPUP_SEL, STATUS_SEL, LINKED_SEL].join(', ');

  /* Changes in these are never news about a post: a player ticks its clock
     and redraws its captions while it plays, an editor changes with every
     key you press, and a hover card fills in when you point at a name. */
  var QUIET_SEL = [PLAYER_SEL, EDITOR_SEL, OURS_SEL, POPUP_SEL, STATUS_SEL, LINKED_SEL].join(', ');

  /* One pass over a post's text, skipping timestamps, joined two ways.
     textContent runs neighbouring elements together with nothing in between,
     so a title starting right after an author name reads "u/someonetrump" and
     whole-word matching misses the word — hence a spaced join. The unspaced
     join is kept alongside it for a word split across inline tags.

     Timestamps are found with one native query and their text nodes skipped
     by identity, rather than filtering every node through a JS callback,
     which would cost a call per element of every post on every scan. */
  function readText(el) {
    var chunks = textChunks(el);
    return chunks.join('') + ' ' + chunks.join(' ');
  }

  function textChunks(el) {
    var skip = null;
    var stamps = el.querySelectorAll(SKIP_SEL);
    if (stamps.length) {
      skip = new Set();
      stamps.forEach(function (stamp) {
        var inner = document.createTreeWalker(stamp, NodeFilter.SHOW_TEXT);
        var t;
        while ((t = inner.nextNode())) skip.add(t);
      });
    }

    var chunks = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && !(skip && skip.has(node))) chunks.push(node.nodeValue);
    }
    return chunks;
  }

  /* skipImages: the post's own text only, without what was read from its
     pictures — used to tell where a match came from. */
  function textOf(el, skipImages) {
    var parts = [readText(el)];
    if (!skipImages) parts.push(imageTextOf(el));

    var own = el.getAttribute && el.getAttribute('aria-label');
    if (own) parts.push(own);

    try {
      el.querySelectorAll('[title], [aria-label], img[alt]').forEach(function (n) {
        if (n.closest(SKIP_SEL)) return;             // a timestamp's hover date isn't content
        var title = n.getAttribute('title');
        if (title) parts.push(title);
        var aria = n.getAttribute('aria-label');
        if (aria) parts.push(aria);
        var alt = n.getAttribute('alt');
        if (alt) parts.push(alt);
      });
    } catch (e) { /* ignore */ }

    return parts.join(' ');
  }

  function matchedWord(el) {
    /* Reading a post's text is the expensive part of a scan, and a long feed
       has hundreds of posts. One that hasn't changed since it was last read
       can only give the same answer. */
    if (isFresh(el)) return null;

    var text = textOf(el);
    if (text.length < 2) return null;              // not hydrated yet
    noteRead(el);

    /* Skip only if the text is exactly what we already tested. Comparing
       lengths instead is unsound: sites build a card in stages, and if the
       finished text happens to match the length of the half-built text we
       already rejected, the post would never be re-tested — it stays visible
       forever, however plainly it matches. */
    var prev = seen.get(el);
    if (prev && prev.v === version && prev.text === text) return null;
    seen.set(el, { v: version, text: text });
    return firstMatch(text);
  }

  function firstMatch(text) {
    text = WF.fold(text);        // the list was folded the same way (WF.compile)
    for (var i = 0; i < patterns.length; i++) {
      patterns[i].re.lastIndex = 0;
      if (patterns[i].re.test(text)) return patterns[i].word;
    }
    return null;
  }

  /* ------------------------------------------------------- text in images

     The post's image text joins its visible text, so everything downstream —
     matching, the recycling check, relabelling — treats a word in a picture
     like any other word. A read landing just re-runs the scan: the post's
     text has changed, so it is tested again.

     Blurring is CSS (hidden.css), not script, so a picture is blurred from
     the frame it appears in rather than whenever the next scan gets to it.
     It blurs every eligible image in a switched-on post unless the img
     carries data-wf-read equal to its current src. This code only ever sets
     that marker, once the image is read — or when there's no point reading
     it, as in a post you chose to reveal. */

  function imageTextOf(el) {
    if (!ocrOn) return '';
    var parts = [];
    try {
      el.querySelectorAll(PICTURE_SEL).forEach(function (n) {
        picturesOf(n).forEach(function (src) {
          var text = ocrText.get(WF.ocrImageKey(src));
          if (text) parts.push(text);
        });
      });
    } catch (e) { /* ignore */ }
    return parts.join('\n');
  }

  function markRead(root) {
    try {
      root.querySelectorAll(IMG_SEL).forEach(function (img) {
        img.setAttribute('data-wf-read', img.getAttribute('src'));
      });
    } catch (e) { /* ignore */ }
  }

  function keepText(key, text) {
    ocrText.delete(key);
    ocrText.set(key, text);
    if (ocrText.size > OCR_KEEP) ocrText.delete(ocrText.keys().next().value);
  }

  function askRead(key, src) {
    ocrAsked.add(key);
    var settled = false;

    function finish(text) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ocrAsked.delete(key);
      keepText(key, text);
      // The posts showing it now say more than when they were last read.
      try {
        document.querySelectorAll(PICTURE_SEL).forEach(function (n) {
          var shows = picturesOf(n).some(function (src) { return WF.ocrImageKey(src) === key; });
          if (shows) changedIn(n);
        });
      } catch (e) { /* ignore */ }
      schedule();
    }

    var timer = setTimeout(function () { finish(''); }, OCR_TIMEOUT);
    browser.runtime.sendMessage({ type: 'wf-ocr', url: src }).then(function (res) {
      if (res && res.error === 'permission') {
        // Allowed on another device, not this one. Stop, and unblur.
        ocrGranted = false;
        updateOcr();
      }
      finish(res && typeof res.text === 'string' ? res.text : '');
    }, function () { finish(''); });
  }

  /* Which images to read next: unread, not in a post already hidden, and
     close to the screen — nearest first, a couple at a time, so a fast scroll
     doesn't leave a queue of pictures nobody will see ahead of the ones that
     are on screen now. A spacer's pictures count too: a post hidden for its
     title, with its player torn out, can stop matching when the list
     changes, and then its picture still deserves a read. */
  function readImages() {
    if (!ocrOn || !postSel) return;

    var nodes;
    try { nodes = document.querySelectorAll(PICTURE_SEL); } catch (e) { return; }

    var view = window.innerHeight || 800;
    var wanted = [];
    nodes.forEach(function (n) {
      var isImg = n.tagName === 'IMG';
      picturesOf(n).forEach(function (src) {
        if (isImg && n.getAttribute('data-wf-read') === src) return;

        var post;
        try { post = n.closest(postSel); } catch (e) { return; }
        if (!post) return;                              // not in a filtered post; not blurred

        var decidedBy = n.closest('[data-wf-state]');
        var state = decidedBy && decidedBy.dataset.wfState;
        if (state === 'hidden') return;                 // unseen anyway; don't spend time on it
        if (state === 'revealed') { if (isImg) n.setAttribute('data-wf-read', src); return; }

        var key = WF.ocrImageKey(src);
        if (ocrText.has(key)) { if (isImg) n.setAttribute('data-wf-read', src); return; }
        if (ocrAsked.has(key) || document.hidden) return;

        var rect = n.getBoundingClientRect();
        if (!rect.width && !rect.height) rect = post.getBoundingClientRect();
        var distance = rect.bottom < 0 ? -rect.bottom : Math.max(0, rect.top - view);
        if (distance > view * OCR_AHEAD) return;
        wanted.push({ key: key, src: src, distance: distance });
      });
    });

    wanted.sort(function (a, b) { return a.distance - b.distance; });
    for (var i = 0; i < wanted.length && ocrAsked.size < OCR_INFLIGHT; i++) {
      if (!ocrAsked.has(wanted[i].key)) askRead(wanted[i].key, wanted[i].src);
    }
  }

  /* On, only when it can do something: the setting, a list to match against,
     and Firefox's permission on this device. The blur is keyed on the post
     groups switched on, so a disabled group's pictures are never blurred —
     nothing there would ever read them. */
  function updateOcr() {
    var was = ocrOn;
    ocrOn = !!(active && cfg.ocr && ocrGranted);

    var groups = (WF.SCOPES[SITE] || []).filter(function (g) {
      return cfg.sites[g.key];
    }).map(function (g) { return g.key; });

    var root = document.documentElement;
    if (ocrOn && cfg.ocrBlur && groups.length) root.setAttribute('data-wf-ocr-blur', groups.join(' '));
    else root.removeAttribute('data-wf-ocr-blur');

    if (ocrOn !== was) {
      version++;                 // image text joins or leaves every post's text
      schedule();
    }
  }

  /* --------------------------------------------------------------- shorts

     The Shorts player is not a feed: one Short fills the screen, so a
     placeholder there is just a blank screen. A matching Short is skipped
     instead, and covered and paused for the moment that takes.

     Both players — ytd-shorts on desktop, shorts-page on m.youtube.com — keep
     a single renderer and a single <video>, and move them into whichever slot
     is on screen as you swipe. Two rules from the feed don't carry over:

     - The video is paused, never torn out. It plays every Short after this
       one too.
     - The address bar isn't proof of what's on screen. Desktop changes the
       URL ~150ms before the renderer changes its text, so for a moment the
       new Short wears the old one's title — and, if that one was skipped,
       would be skipped too. Nothing is decided until the visible text has
       moved on from what the previous Short was decided on. Only words are
       compared: blank text nodes come and go a beat before the real change,
       and aria-labels flicker through in-between values.

     A Short is skipped the way you're going: Next on the way down, Previous
     on the way back up, every time it comes up. Always skipping down would
     make a Short you came back to a wall you could never get above. Which
     way you're going comes from the order Shorts were first shown in: the
     player only ever adds new ones at the bottom. At the top, with nothing
     above to skip to, a Short reached going up stays covered instead. */

  var SHORT_SEL = 'ytd-reel-video-renderer, shorts-video';
  var SHORT_NEXT_SEL = '#navigation-button-down button, .ytShortsCarouselShortsA11yNav button:last-of-type';
  var SHORT_PREV_SEL = '#navigation-button-up button, .ytShortsCarouselShortsA11yNav button:first-of-type';
  var SHORT_STALE_MS = 1500;     // two Shorts can share their text; stop waiting for a change
  var SHORT_RETRY_MS = 2500;     // a skip that hasn't moved the player by now didn't take
  var SHORT_TRIES = 3;           // then it isn't going to: leave it covered
  var SHORT_SHOWN_MS = 1200;     // the player ignores Next this soon after its tab is shown

  var short = newShort('', null, null, false);
  var shortsOrder = new Map();     // id -> position, in the order first shown
  var shortsRevealed = new Set();  // ids you clicked Show on
  var shortsMatched = new Map();   // id -> word, for the popup's counts
  var guarded = null;              // the <video> held paused under the placeholder
  var shownAt = 0;                 // when this tab last came to the front
  var shortMark = '';              // what the renderer is marked as, to leave it be if unchanged

  function newShort(id, el, stale, up) {
    return {
      id: id, el: el, since: Date.now(),
      stale: stale,              // the previous Short's visible text, until the renderer moves on
      text: null,                // this one's, once it has arrived
      up: up,                    // reached by going back up
      word: null, matchSince: 0, tries: 0, skippedAt: 0,
      leaving: false             // the player has already loaded the next Short
    };
  }

  /* Whether id was reached going up from the Short before it, from. A Short
     never shown before is always below the ones that were. */
  function wentUp(id, from) {
    return shortsOrder.has(id) && shortsOrder.has(from) && shortsOrder.get(id) < shortsOrder.get(from);
  }

  function shortId() {
    var m = /^\/shorts\/([\w-]+)/.exec(location.pathname);
    return m ? m[1] : '';
  }

  /* Desktop once rendered one renderer per Short and marked the one on
     screen is-active. Both shapes are handled. */
  function activeShort() {
    var all = document.querySelectorAll(SHORT_SEL);
    for (var i = 0; i < all.length; i++) if (all[i].hasAttribute('is-active')) return all[i];
    for (i = 0; i < all.length; i++) if (all[i].querySelector('video')) return all[i];
    return all[0] || null;
  }

  /* 'emptied' is the player loading the next Short into the same element.
     It fires before that Short starts playing and well before the URL
     changes, so the guard lets go at exactly the right moment — and nothing
     is done to this Short after it, or a scan landing in that gap would
     pause the next one. */
  function pauseGuarded(ev) { ev.target.pause(); }

  function leaveShort() {
    short.leaving = true;
    unguardVideo();
  }

  /* The words in a Short's own text, without the blank nodes around them. */
  function shortWords(el) {
    return textChunks(el).map(function (t) { return t.trim(); })
      .filter(Boolean).join(' ');
  }

  function guardVideo(el) {
    var v = el.querySelector('video');
    if (!v || v === guarded) return;
    unguardVideo();
    guarded = v;
    v.addEventListener('play', pauseGuarded, true);
    v.addEventListener('emptied', leaveShort, true);
    try { v.pause(); } catch (e) { /* ignore */ }
  }

  function unguardVideo() {
    if (!guarded) return;
    guarded.removeEventListener('play', pauseGuarded, true);
    guarded.removeEventListener('emptied', leaveShort, true);
    guarded = null;
  }

  function markShort(el, state, word, verb, inImage) {
    var mark = [state, verb, word, inImage].join(' ');
    if (el.dataset.wfShort && shortMark === mark) return;
    unmarkShort(el, false);
    shortMark = mark;
    el.dataset.wfShort = state;
    el.dataset.wfWord = word;
    if (inImage) el.dataset.wfWhere = 'image';
    if (state === 'hidden') addVeil(el, word, verb, revealShort);
  }

  function unmarkShort(el, resume) {
    if (!el) return;
    shortMark = '';
    el.removeAttribute('data-wf-short');
    el.removeAttribute('data-wf-word');
    el.removeAttribute('data-wf-where');
    try {
      el.querySelectorAll(':scope > .wf-veil').forEach(function (v) { v.remove(); });
    } catch (e) { /* ignore */ }
    if (resume && guarded) {
      var v = guarded;
      unguardVideo();
      try { v.play(); } catch (e) { /* ignore */ }
    }
  }

  function revealShort(el) {
    shortsRevealed.add(short.id);
    short.word = null;
    unmarkShort(el, true);
  }

  /* Settings changed: the Short on screen is decided again under the new
     ones. It keeps its place and the way you were going, so a word added
     while scrolling up doesn't send you back down, and a skip already under
     way carries on rather than starting a second one. */
  function resetShorts() {
    unmarkShort(short.el, true);
    unguardVideo();
    short.word = null;
    short.matchSince = 0;
    shortsMatched.clear();
  }

  /* Text in images, for Shorts. A Short is a video, and the extension only
     reads pictures. But YouTube keeps each Short's first frame as a picture
     at i.ytimg.com/vi/ID/frame0.jpg — the desktop player even puts it behind
     every slot, upcoming ones included — and burned-in captions are nearly
     always on it. Measured on eleven Shorts, it read captions at least as
     well as the full-size thumbnail, in about 0.5s against 0.8s.

     The Short on screen is read first, then the next few in the queue, so a
     swipe usually lands on one that has already been read. */
  var SHORT_FRAME_AHEAD = 2;
  var SHORT_FRAME_RE = /i\.ytimg\.com\/vi\/([\w-]+)\/frame0\.jpg/;
  var SHORT_QUEUE_SEL = 'ytd-shorts [style*="i.ytimg.com/vi/"], shorts-page [style*="i.ytimg.com/vi/"]';

  function frameUrl(id) {
    return 'https://i.ytimg.com/vi/' + id + '/frame0.jpg';
  }

  /* What this Short's first frame says: '' for nothing, null if not read yet. */
  function frameText(id) {
    var text = ocrText.get(WF.ocrImageKey(frameUrl(id)));
    return typeof text === 'string' ? text : null;
  }

  function readShortFrames(id) {
    if (!ocrOn || document.hidden) return;
    var ids = [id];
    var after = false;
    try {
      document.querySelectorAll(SHORT_QUEUE_SEL).forEach(function (n) {
        var m = SHORT_FRAME_RE.exec(n.getAttribute('style') || '');
        if (!m) return;
        if (m[1] === id) after = true;
        else if (after && ids.length <= SHORT_FRAME_AHEAD && ids.indexOf(m[1]) === -1) ids.push(m[1]);
      });
    } catch (e) { /* ignore */ }

    ids.forEach(function (one) {
      var src = frameUrl(one);
      var key = WF.ocrImageKey(src);
      if (ocrText.has(key) || ocrAsked.has(key) || ocrAsked.size >= OCR_INFLIGHT) return;
      askRead(key, src);
    });
  }

  function scanShort() {
    if (!shortId()) shortsOrder.clear();     // left the player; a new visit starts a new list
    var id = active && cfg.sites.youtubeVideos ? shortId() : '';
    var el = id ? activeShort() : null;

    if (id !== short.id || el !== short.el) {
      /* A different renderer is let go of now. The same one, showing a new
         Short, keeps its placeholder until its new text arrives and is
         decided on: until then it is still showing the old Short's text. */
      if (short.el !== el) unmarkShort(short.el, false);
      unguardVideo();
      var up = id === short.id ? short.up : wentUp(id, short.id);
      if (id && !shortsOrder.has(id)) shortsOrder.set(id, shortsOrder.size);
      short = newShort(id, el, short.text !== null ? short.text : short.stale, up);
    }
    if (!el || short.leaving) return;

    var visible = shortWords(el);
    if (short.text === null) {
      if (visible.length < 2) return;
      if (visible === short.stale && Date.now() - short.since < SHORT_STALE_MS) {
        setTimeout(schedule, 300);
        return;
      }
    }
    short.text = visible;

    readShortFrames(id);
    var word = null;
    var inImage = false;
    var unread = false;
    if (!shortsRevealed.has(id)) {
      word = firstMatch(textOf(el));
      var frame = ocrOn ? frameText(id) : '';
      if (!word && frame) {
        word = firstMatch(frame);
        inImage = !!word;
      }
      unread = frame === null && cfg.ocrBlur && !cfg.revealAll;
    }

    if (!word) {
      short.word = null;
      shortsMatched.delete(id);
      if (unread) {
        // Blur until read, as in a feed: covered and held until its frame is read.
        markShort(el, 'hidden', '', 'Reading');
        guardVideo(el);
      } else {
        unmarkShort(el, true);
      }
      return;
    }

    if (word !== short.word) {
      short.word = word;
      short.matchSince = Date.now();
    }
    shortsMatched.set(id, word);

    if (cfg.revealAll) {
      markShort(el, 'marked', word, '', inImage);
      return;
    }

    /* Nothing above the top Short to skip to, and a player that has ignored
       every try isn't going to move: covered, with Show, either way. */
    var top = short.up && shortsOrder.get(id) === 0;
    var stuck = short.tries >= SHORT_TRIES && Date.now() - short.skippedAt >= SHORT_RETRY_MS;
    markShort(el, 'hidden', word, top || stuck ? 'Hidden' : 'Skipping', inImage);
    guardVideo(el);
    if (top || stuck) return;

    /* A skip that worked has already moved on: 'emptied' set leaving, or the
       address changed and this is a new Short. Still here after a while
       means the player ignored the click, so it is clicked again. */
    if (short.tries && Date.now() - short.skippedAt < SHORT_RETRY_MS) return;

    /* Like the feed's recycling check: a match has to hold for a moment
       before it is acted on, in case the text was still settling. */
    if (Date.now() - short.matchSince < SETTLE_MS) {
      setTimeout(schedule, SETTLE_MS + 50);
      return;
    }

    /* The player ignores Next in a tab that isn't showing, so a Short opened
       in a background tab stayed covered for good. It waits, covered and
       paused, until the tab is shown (visibilitychange rescans) — and a
       moment longer. A paused player that was loaded in the background
       ignores Next for a while after it is shown, with nothing to say when
       it's ready: measured in Chrome 155, 0.8s was ignored and 0.9s on
       worked. The retry above covers a machine that needs longer. */
    if (document.hidden) return;
    var shown = Date.now() - shownAt;
    if (shown < SHORT_SHOWN_MS) {
      setTimeout(schedule, SHORT_SHOWN_MS - shown + 50);
      return;
    }

    var button = document.querySelector(short.up ? SHORT_PREV_SEL : SHORT_NEXT_SEL);
    if (button) {
      short.tries++;
      short.skippedAt = Date.now();
      button.click();
      setTimeout(schedule, SHORT_RETRY_MS + 50);
    }
  }

  function inDocumentOrder(a, b) {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  /* Posts not yet decided, in document order, so a post is reached before
     any post nested inside it. Bare tag names are looked up by tag, a list
     the browser keeps ready: matching the whole selector list against a
     long YouTube feed took ~20ms, every scan, against ~0.5ms this way. */
  function unseenPosts() {
    var out = [];
    postTags.forEach(function (tag) {
      var all = document.getElementsByTagName(tag);
      for (var i = 0; i < all.length; i++) {
        if (!all[i].hasAttribute('data-wf-state')) out.push(all[i]);
      }
    });
    if (unseenSel) {
      document.querySelectorAll(unseenSel).forEach(function (el) { out.push(el); });
    }
    return out.sort(inDocumentOrder);
  }

  function scan() {
    if (SITE === 'youtube') scanShort();
    if (!active) return;
    recheck();

    var list;
    try { list = unseenPosts(); } catch (e) { return; }

    list.forEach(function (el) {
      // A post nested inside an already-hidden one is handled by its ancestor.
      if (el.parentElement && el.parentElement.closest('[data-wf-state="hidden"]')) return;
      // The popup in a hover card can itself be an <article>; it's part of the card.
      if (el.closest(POPUP_SEL)) return;

      var word = matchedWord(el);
      if (!word) return;

      if (cfg.revealAll) mark(el, word);
      else hide(el, word);
    });

    readImages();
  }

  /* ------------------------------------------------------------ scheduling */

  var pending = false;
  var lastRun = 0;

  function schedule() {
    if (pending) return;
    pending = true;
    var wait = Math.max(0, 150 - (Date.now() - lastRun));
    setTimeout(function () {
      pending = false;
      lastRun = Date.now();
      scan();
    }, wait);
  }

  function isOurs(node) {
    return node.nodeType === 1 &&
      node.classList &&
      (node.classList.contains('wf-veil') || node.classList.contains('wf-spacer'));
  }

  function elementOf(node) {
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function isQuiet(node) {
    var el = elementOf(node);
    try { return !el || !!el.closest(QUIET_SEL); } catch (e) { return false; }
  }

  /* Something inside node changed, so every post around it has to be read
     again. Posts can nest — a reply inside its thread — hence the climb. */
  function changedIn(node) {
    if (!postSel) return;
    try {
      var post = elementOf(node);
      while (post && (post = post.closest(postSel))) {
        readAt.delete(post);
        post = post.parentElement;
      }
    } catch (e) { /* ignore */ }
  }

  /* An img whose src changes is a different picture — YouTube re-stamps
     thumbnails in place — so its "read" marker goes at once, here, rather
     than at the next scan. Observer callbacks run before the page paints
     again, so the new picture is blurred from its first frame. */
  var observer = new MutationObserver(function (mutations) {
    var changed = false;
    var done = new Set();
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      var t = m.target;
      if (m.type === 'attributes' && m.attributeName === 'src') {
        if (t.tagName !== 'IMG') continue;
        var read = t.getAttribute('data-wf-read');
        if (read !== null && read !== t.getAttribute('src')) t.removeAttribute('data-wf-read');
        if (!ocrOn) continue;    // without image text, a new picture says nothing new
      } else if (m.type === 'childList' && m.addedNodes.length) {
        var ours = true;
        for (var j = 0; j < m.addedNodes.length; j++) {
          if (!isOurs(m.addedNodes[j])) { ours = false; break; }
        }
        if (ours) continue;      // our own veil/spacer insertions
      }
      if (done.has(t)) continue;
      done.add(t);
      if (isQuiet(t)) continue;
      changedIn(t);
      changed = true;
    }
    if (changed) schedule();
  });

  /* --------------------------------------------------------------- config */

  function apply(next) {
    cfg = next;
    patterns = WF.compileAll(cfg.words, cfg.matchMode);

    var selectors = WF.selectorsFor(SITE, cfg);
    var isTag = function (s) { return /^[a-z][a-z0-9-]*$/i.test(s); };
    postTags = selectors.filter(isTag);
    unseenSel = selectors.filter(function (s) { return !isTag(s); })
      .map(function (s) { return s + ':not([data-wf-state])'; }).join(',');
    postSel = selectors.join(',');

    active = !!(cfg.enabled && selectors.length && patterns.length);
    unhideAll();                 // also bumps version, invalidating the text cache
    updateOcr();
    scan();

    /* Whether Firefox has allowed the image hosts on this device. Until the
       answer arrives, nothing is blurred: better a picture shown a moment
       early than a feed of pictures blurred for good by a background page
       that can't read them. */
    if (cfg.ocr && active) {
      browser.runtime.sendMessage({ type: 'wf-ocr-ready' }).then(function (res) {
        ocrGranted = !!(res && res.granted);
        updateOcr();
      }, function () {
        ocrGranted = false;
        updateOcr();
      });
    }
  }

  /* Settings are written to both sync and local, so one edit arrives twice,
     and a sync pull can deliver an older copy than the one on this machine.
     Don't trust newValue: re-read, and let the newer copy win. */
  browser.storage.onChanged.addListener(function (changes) {
    if (!changes.wfConfig) return;
    WF.loadConfig().then(apply);
  });

  browser.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;

    if (msg.type === 'wf-stats') {
      var counts = {};
      var total = 0;
      document.querySelectorAll('[data-wf-state="hidden"],[data-wf-state="marked"]').forEach(function (el) {
        total++;
        var w = el.dataset.wfWord || '';
        counts[w] = (counts[w] || 0) + 1;
      });
      shortsMatched.forEach(function (w) {
        total++;
        counts[w] = (counts[w] || 0) + 1;
      });
      return Promise.resolve({ site: SITE, active: active, total: total, counts: counts });
    }

    if (msg.type === 'wf-unhide-all') {
      unhideAll();
      return Promise.resolve({ ok: true });
    }
  });

  /* ----------------------------------------------------------------- boot */

  /* characterData is belt-and-braces for a title that is rewritten in place
     rather than by swapping nodes. Chromium reports that as childList, which
     is already covered; Gecko has a single-text-child fast path that may report
     it as characterData instead, and this extension ships to Firefox.

     title, aria-label and alt are read as part of a post, so a change to one
     is a change to the post; src is a thumbnail swapped in place. */
  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'title', 'aria-label', 'alt']
  });
  document.addEventListener('DOMContentLoaded', schedule);

  // Reading images goes by what's near the screen, which scrolling changes
  // without touching the DOM. Capture, so inner scrolling panes count too.
  window.addEventListener('scroll', function () { if (ocrOn) schedule(); }, { passive: true, capture: true });
  // A Short left covered in a background tab is skipped once the tab is shown.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) shownAt = Date.now();
    if (ocrOn || short.id) schedule();
  });

  // Backstop: catches lazily hydrated posts and any player Reddit re-attaches
  // inside a post we already hid, and re-reads posts as they come due (see
  // noteRead).
  setInterval(function () {
    sweeps++;
    scan();
    maintainHidden();
  }, 1200);

  WF.loadConfig().then(apply);
})();
