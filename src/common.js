/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Quiet Feed — shared config, site table and keyword matching.
   Loaded by the content script, the popup and the options page. */

var WF = (function () {
  'use strict';

  var DEFAULTS = {
    enabled: true,
    words: [],
    matchMode: 'word',        // 'word' = whole word (+ plural/possessive) | 'substring'
    hideMode: 'placeholder',  // 'placeholder' = keep the slot | 'collapse' = remove the slot
    showLabel: true,          // show which word matched on the placeholder
    revealAll: false,         // tuning mode: outline matches instead of hiding them
    killMedia: true,          // tear out video/audio/iframes inside hidden posts
    ocr: false,               // also read the text inside post images (needs a permission)
    ocrBlur: false,           // blur those images until they've been read (slow on a full page)
    autoBackup: false,        // save a copy to Downloads after changes (needs a permission)
    listCollapsed: false,     // popup: word list folded away
    savedAt: 0,               // decides which copy wins between sync and local
    sites: {
      youtubeVideos: true, youtubeComments: true,
      redditPosts: true, redditComments: true,
      x: true
    },
    /* Opt-in soft lock on changing settings. Off unless you turn it on. */
    lock: { enabled: false, salt: '', hash: '', iterations: 210000 }
  };

  var UNLOCK_KEY = 'wfUnlockUntil';
  var UNLOCK_MINUTES = 5;

  /* Post containers, grouped so each group can be switched on or off on its
     own. Splitting a site further later means adding a group here plus a
     toggle in the UI — nothing else changes.

     Selectors are deliberately leaf-ish: hiding a whole shelf or section
     because one video inside it matched would be too blunt.

     Desktop and mobile markup share a group rather than splitting into two.
     A page only ever renders one of the two, the unused half costs a failed
     querySelectorAll, and nobody wants to switch on "YouTube videos" twice. */
  var SCOPES = {
    youtube: [
      {
        key: 'youtubeVideos',
        selectors: [
          'ytd-rich-item-renderer',
          'ytd-video-renderer',
          'ytd-grid-video-renderer',
          'ytd-compact-video-renderer',
          'ytd-playlist-renderer',
          'ytd-playlist-video-renderer',
          'ytd-radio-renderer',
          'ytd-channel-renderer',
          'ytd-reel-item-renderer',
          'ytd-post-renderer',            // community posts
          'ytd-notification-renderer',
          /* m.youtube.com serves ytm- elements, and it is not a plain rename of
             the ytd- ones. The same video is a video-with-context-renderer in
             search results and in the watch page's related list, but a
             compact-video-renderer in a channel grid, where rich-item-renderer
             wraps it.

             compact-video-renderer stays on the list even though every one seen
             on a phone so far sat inside a rich-item-renderer. It is the mobile
             twin of ytd-compact-video-renderer, which does stand on its own on
             desktop, and only logged-out pages could be checked here. Matching
             a box that is already inside a hidden one costs nothing.

             ytm-media-item is the one deliberately left out. It sits inside
             every item above on every surface checked — never once on its own —
             so listing it would only re-hide what is already hidden. */
          'ytm-rich-item-renderer',
          'ytm-video-with-context-renderer',
          'ytm-compact-video-renderer',
          'ytm-compact-playlist-renderer',
          'ytm-shorts-lockup-view-model',
          'ytm-shorts-lockup-view-model-v2',
          'yt-lockup-view-model'
        ]
      },
      {
        key: 'youtubeComments',
        selectors: [
          'ytd-comment-thread-renderer',  // a top-level comment and its replies
          'ytd-comment-view-model',       // an individual reply
          'ytd-comment-renderer',         // older markup
          /* Mobile keeps the same two-level shape, in a sheet that slides up
             over the video rather than a column under it. */
          'ytm-comment-thread-renderer',
          'ytm-comment-renderer'
        ]
      }
    ],
    /* Reddit needs no mobile equivalents: unlike YouTube it ships the same
       shreddit- components to a phone as to a desktop, so the selectors below
       already cover the mobile feed. The one thing only a narrow viewport
       turns up is the recommendation list on a post page. */
    reddit: [
      {
        key: 'redditPosts',
        selectors: [
          'shreddit-post',
          'shreddit-ad-post',
          'article',
          'reddit-pdp-right-rail-post',  // "more posts like this" on a post page
          'div.thing.link',     // old.reddit.com
          'div.Post'            // legacy redesign
        ]
      },
      {
        key: 'redditComments',
        selectors: [
          'shreddit-comment',
          'shreddit-comment-tree-ad',    // promoted slot between comments
          'div.thing.comment'   // old.reddit.com
        ]
      }
    ],
    /* One group, not two: unlike Reddit and YouTube, X renders a reply with
       exactly the same markup as a post, so there is nothing to split on.

       Keep `article` plain. Logged-out X — which is all a visitor without an
       account ever sees — renders posts without the data-testid="tweet" and
       role="article" attributes that the signed-in timeline carries, so
       matching on those quietly hid nothing at all. */
    x: [
      {
        key: 'x',
        selectors: [
          'div[data-testid="cellInnerDiv"]',   // timeline cell, separator and all
          'article',                           // the post itself, signed in or not
          'div[data-testid="trend"]',          // trending entries
          'div[role="link"]'                   // quote posts, link cards, suggestions
        ]
      }
    ]
  };

  /* The selectors currently switched on for a site. Empty means "do nothing
     here", which is how a fully disabled site is expressed. */
  function selectorsFor(site, cfg) {
    var groups = SCOPES[site] || [];
    var out = [];
    groups.forEach(function (group) {
      if (cfg && cfg.sites && cfg.sites[group.key]) out = out.concat(group.selectors);
    });
    return out;
  }

  /* Anything here, found inside a hidden post, gets replaced by an invisible
     spacer of the same size. The custom elements matter because Reddit keeps
     its <video> inside an open shadow root. */
  var MEDIA = {
    youtube: 'video, audio, iframe',
    reddit: 'video, audio, iframe, shreddit-player, shreddit-player-2, shreddit-embed, gif-post-legacy, playback-controller',
    x: 'video, audio, iframe, div[data-testid="videoPlayer"]'
  };

  /* ------------------------------------------------------ text in images

     Which images are read when "Read text in images" is on: the pictures a
     post is *about* — thumbnails, photos, memes, screenshots, link cards —
     and never avatars, emoji or icons, which live on other paths or hosts.

     A URL qualifies by prefix, and nothing else, because hidden.css blurs
     unread images with the same prefixes as [src^="..."] selectors. If the
     two ever disagreed, an image could be blurred and then never read, and
     stay blurred for good. The self-check compares them. */
  var OCR_IMAGES = [
    'https://i.ytimg.com/vi/',                  // video and Shorts thumbnails
    'https://i.ytimg.com/vi_webp/',
    'https://i.redd.it/',                       // Reddit image posts and galleries
    'https://preview.redd.it/',
    'https://cf.preview.redd.it/',              // the same previews, served to some users
    'https://external-preview.redd.it/',        // link-post previews
    'https://pbs.twimg.com/media/',             // photos on X
    'https://pbs.twimg.com/card_img/',          // link cards
    'https://pbs.twimg.com/ext_tw_video_thumb/',
    'https://pbs.twimg.com/amplify_video_thumb/',
    'https://pbs.twimg.com/tweet_video_thumb/'
  ];

  /* What Firefox is asked to allow when the feature is switched on. Optional,
     so nobody who leaves it off ever grants them. */
  var OCR_ORIGINS = [
    'https://i.ytimg.com/*',
    'https://i.redd.it/*',
    'https://preview.redd.it/*',
    'https://cf.preview.redd.it/*',
    'https://external-preview.redd.it/*',
    'https://pbs.twimg.com/*'
  ];

  function ocrImageUrl(url) {
    url = String(url || '');
    if (/[\s"'<>\\]/.test(url)) return null;
    for (var i = 0; i < OCR_IMAGES.length; i++) {
      if (url.indexOf(OCR_IMAGES[i]) === 0 && url.length > OCR_IMAGES[i].length) return url;
    }
    return null;
  }

  /* One picture can be served under several URLs. Reddit shows each post
     image twice — the picture, and a blurred copy behind it — one from
     i.redd.it/ID.jpeg, the other from preview.redd.it/some-title-v0-ID.jpeg
     (or cf.preview.redd.it) at a different size. Keyed by that ID, it is
     read once. Anything else is its own key. */
  function ocrImageKey(url) {
    var m = /^https:\/\/(?:i|preview|cf\.preview)\.redd\.it\/(?:[^\/?#]*-v0-)?([a-z0-9]{8,20})\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.exec(url);
    return m ? 'redd.it/' + m[1].toLowerCase() : url;
  }

  /* The permission pattern covering one image URL. The list above can grow,
     and Firefox never grants a new host by itself: someone who switched this
     on before a host was added hasn't allowed it. So reads are checked per
     host, not against the whole list. */
  function ocrOriginFor(url) {
    try { return 'https://' + new URL(url).host + '/*'; } catch (e) { return null; }
  }

  function detectSite(hostname) {
    if (/(^|\.)youtube\.com$/.test(hostname)) return 'youtube';
    if (/(^|\.)reddit\.com$/.test(hostname)) return 'reddit';
    if (/(^|\.)x\.com$/.test(hostname)) return 'x';
    if (/(^|\.)twitter\.com$/.test(hostname)) return 'x';
    return null;
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* Whole-word matching: letters and digits either side end a word, and so
     does anything else — except an underscore, which never separates words
     in writing, only in names.

     A handle is one word, however it is punctuated: @something-ad-nonsense,
     u/some.name, r/some_sub. Every Short shows its channel's handle, so
     reading "ad" out of the middle of one hid a whole channel's Shorts for
     a word nobody could see there. A word matches a handle only by covering
     all of it, with or without the @ or u/ — so a channel can still be
     blocked by name. */
  var WORD_CHAR = '[\\p{L}\\p{N}_]';
  var HANDLE_START = '(?:@|(?<![\\p{L}\\p{N}_])[ur]/)';
  var HANDLE_CHAR = '[\\p{L}\\p{N}_.-]';

  function wholeWord(body) {
    body += '(?:[’\']?s)?';                 // plurals and possessives
    var atStart = '(?<=' + HANDLE_START + ')' + body +
      '(?!' + WORD_CHAR + '|[.-]' + WORD_CHAR + ')';
    var elsewhere = '(?<!' + WORD_CHAR + ')(?<!' + HANDLE_START + ')' +
      '(?<!' + HANDLE_START + HANDLE_CHAR + '*[.-])' + body + '(?!' + WORD_CHAR + ')';
    return '(?:' + atStart + '|' + elsewhere + ')';
  }

  /* A phrase is its words, in order; what lies between them doesn't matter.
     Pictures made that necessary: the reader keeps only words with a letter
     or digit in them, so "Mitchell & Webb" in a picture reads "Mitchell
     Webb", and a phrase that insisted on the "&" never matched it. So any run
     of spaces and punctuation separates two words, a symbol typed on its own
     between them is only a separator, and "&", "+" and "and" stand for each
     other — or for nothing, since the reader drops the first two. A word
     with punctuation inside it, like "c++" or "AT&T", is kept as typed. */
  var PHRASE_SEP = '[^\\p{L}\\p{N}_]+';
  var CONNECTOR = /^(?:&|\+|and)$/i;

  function phraseBody(raw) {
    var tokens = raw.split(/\s+/).filter(function (t) {
      return CONNECTOR.test(t) || /[\p{L}\p{N}]/u.test(t);
    });
    var out = '';
    var words = 0;
    var joined = false;          // the last token was a connector, separator included
    for (var i = 0; i < tokens.length; i++) {
      var between = words > 0 && i < tokens.length - 1 && !CONNECTOR.test(tokens[i + 1]);
      if (CONNECTOR.test(tokens[i]) && between) {
        out += PHRASE_SEP + '(?:and' + PHRASE_SEP + ')?';
        joined = true;
        continue;
      }
      if (words > 0 && !joined) out += PHRASE_SEP;
      out += escapeRe(tokens[i]);
      words++;
      joined = false;
    }
    return words ? out : null;
  }

  /* A keyword is either /a regex/flags, or plain text. Plain text is matched
     case-insensitively; in 'word' mode it needs letter boundaries either side
     and tolerates a trailing plural or possessive s. */
  function compile(word, mode) {
    var raw = String(word || '').trim();
    if (!raw) return null;

    var asRegex = raw.match(/^\/(.+)\/([a-z]*)$/);
    if (asRegex) {
      var flags = asRegex[2].replace(/[gy]/g, '');
      if (flags.indexOf('i') === -1) flags += 'i';
      try { return new RegExp(asRegex[1], flags); } catch (e) { return null; }
    }

    var literal = escapeRe(raw).replace(/\s+/g, '\\s+');
    var body = phraseBody(raw) || literal;
    try {
      if (mode === 'substring') return new RegExp(body, 'iu');
      return new RegExp(wholeWord(body), 'iu');
    } catch (e) {
      try { return new RegExp(literal, 'i'); } catch (e2) { return null; }
    }
  }

  function compileAll(words, mode) {
    var out = [];
    (words || []).forEach(function (w) {
      var re = compile(w, mode);
      if (re) out.push({ word: w, re: re });
    });
    return out;
  }

  /* An entry that won't compile — an unbalanced regex, say — is skipped by
     compileAll. Without these, it would sit in the list looking perfectly
     healthy while silently matching nothing, which is indistinguishable from
     a word that simply isn't coming up. The UIs use them to say so. */
  function isValid(word, mode) {
    return compile(word, mode) !== null;
  }

  function invalidWords(words, mode) {
    return (words || []).filter(function (w) {
      return String(w).trim() && !isValid(w, mode);
    });
  }

  /* ------------------------------------------------------------------ lock

     A deliberate speed bump, not real security.
     It exists to make changing your own list a conscious act. The password is
     never stored — only a PBKDF2-SHA256 hash of it, with a random salt. */

  function toHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function fromHex(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function randomSalt() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return toHex(bytes.buffer);
  }

  function derive(password, saltHex, iterations) {
    var material = new TextEncoder().encode(String(password));
    return crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return crypto.subtle.deriveBits({
          name: 'PBKDF2',
          salt: fromHex(saltHex),
          iterations: iterations,
          hash: 'SHA-256'
        }, key, 256);
      })
      .then(toHex);
  }

  /* Build the stored lock record for a new password. */
  function makeLock(password) {
    var salt = randomSalt();
    var iterations = DEFAULTS.lock.iterations;
    return derive(password, salt, iterations).then(function (hash) {
      return { enabled: true, salt: salt, hash: hash, iterations: iterations };
    });
  }

  function verifyPassword(password, lock) {
    if (!lock || !lock.enabled || !lock.salt || !lock.hash) return Promise.resolve(true);
    return derive(password, lock.salt, lock.iterations || DEFAULTS.lock.iterations)
      .then(function (hash) { return hash === lock.hash; })
      .catch(function () { return false; });
  }

  /* Unlocking lasts a few minutes so the popup and the settings page agree,
     instead of asking again for every single edit. */
  function isUnlocked() {
    return browser.storage.local.get(UNLOCK_KEY).then(function (res) {
      return (res && res[UNLOCK_KEY] || 0) > Date.now();
    });
  }

  function setUnlocked() {
    var until = Date.now() + UNLOCK_MINUTES * 60000;
    var patch = {};
    patch[UNLOCK_KEY] = until;
    return browser.storage.local.set(patch);
  }

  function relock() {
    return browser.storage.local.remove(UNLOCK_KEY);
  }

  function normalize(stored) {
    var cfg = Object.assign({}, DEFAULTS, stored || {});
    cfg.sites = Object.assign({}, DEFAULTS.sites, (stored && stored.sites) || {});
    cfg.lock = Object.assign({}, DEFAULTS.lock, (stored && stored.lock) || {});

    /* Each site used to be one switch; each is now split in two. Carry the old
       setting over to both halves so nobody's choice silently flips. */
    var storedSites = (stored && stored.sites) || {};
    [
      { old: 'reddit', halves: ['redditPosts', 'redditComments'] },
      { old: 'youtube', halves: ['youtubeVideos', 'youtubeComments'] }
    ].forEach(function (migration) {
      if (typeof storedSites[migration.old] !== 'boolean') return;
      migration.halves.forEach(function (half) {
        if (typeof storedSites[half] !== 'boolean') cfg.sites[half] = storedSites[migration.old];
      });
    });
    delete cfg.sites.reddit;
    delete cfg.sites.youtube;
    if (!Array.isArray(cfg.words)) cfg.words = [];
    if (!cfg.lock.salt || !cfg.lock.hash) cfg.lock.enabled = false;
    return cfg;
  }

  /* ---------------------------------------------------------------- backup

     What Export and the automatic backup both write, and Import reads. The
     lock stays out (a hash is useless elsewhere, and a file must never change
     your password), and so does autoBackup: whether this machine may write
     to Downloads is a per-device choice with a per-device permission. */
  function backupPayload(cfg) {
    var payload = JSON.parse(JSON.stringify(normalize(cfg)));
    delete payload.lock;
    delete payload.autoBackup;
    return payload;
  }

  var BACKUP_KEY = 'wfBackup';          // storage.local: how the last backup went
  var BACKUP_DIR = 'Quiet Feed backups';

  /* ---------------------------------------------------------------- storage

     Settings live in storage.sync so they follow you between devices, and are
     mirrored to storage.local. The mirror is not redundancy for its own sake:
     sync has an 8KB-per-item quota and can be unavailable entirely, and a
     word list is the sort of thing people spend months building. If a sync
     write fails we keep the local copy and say so rather than losing it.

     Because either copy can be the fresher one, each carries the time it was
     written and the newer wins. */

  function readArea(store) {
    return store.get('wfConfig')
      .then(function (res) { return (res && res.wfConfig) || null; })
      .catch(function () { return null; });
  }

  function loadConfig() {
    return Promise.all([
      readArea(browser.storage.sync),
      readArea(browser.storage.local)
    ]).then(function (found) {
      var synced = found[0];
      var local = found[1];
      if (synced && local) {
        return normalize((synced.savedAt || 0) >= (local.savedAt || 0) ? synced : local);
      }
      return normalize(synced || local);
    });
  }

  function saveConfig(cfg) {
    var value = normalize(cfg);
    value.savedAt = Date.now();

    return browser.storage.sync.set({ wfConfig: value })
      .then(function () {
        return browser.storage.local.set({ wfConfig: value })
          .then(function () { return { area: 'sync' }; });
      })
      .catch(function (err) {
        // Quota, or no sync at all. Local still has it.
        return browser.storage.local.set({ wfConfig: value })
          .then(function () {
            return { area: 'local', error: String((err && err.message) || err) };
          });
      });
  }

  /* ------------------------------------------------------ concurrent edits

     The popup and the settings page each hold a copy of the config. Saving
     that copy directly meant whichever window saved last overwrote whatever
     the other had changed since it opened — an open settings tab could erase
     words added from the popup with an unrelated click.

     So a change is expressed as a function applied to what is stored *now*:
     read fresh, apply, write. Calls from one page run one after another, so
     two quick edits can't read the same stale state either. */

  var updateQueue = Promise.resolve();

  function updateConfig(mutate) {
    var run = updateQueue.then(function () {
      return loadConfig().then(function (fresh) {
        mutate(fresh);
        return saveConfig(fresh).then(function (result) {
          return { cfg: normalize(fresh), result: result };
        });
      });
    });
    updateQueue = run.catch(function () { /* keep the queue alive after a failure */ });
    return run;
  }

  /* Three-way merge of a word list: what an editor started from (base), what
     it ended up with (mine), and what is stored now (theirs). Words the
     editor added or removed are applied; anything else changed meanwhile is
     kept. Compared case-insensitively, so it never introduces duplicates. */
  function mergeWords(base, mine, theirs) {
    function key(w) { return String(w).toLowerCase(); }

    var inBase = Object.create(null);
    var inMine = Object.create(null);
    base.forEach(function (w) { inBase[key(w)] = true; });
    mine.forEach(function (w) { inMine[key(w)] = true; });

    var seen = Object.create(null);
    var out = [];
    function keep(w) {
      if (seen[key(w)]) return;
      seen[key(w)] = true;
      out.push(w);
    }

    theirs.forEach(function (w) {
      var removedHere = inBase[key(w)] && !inMine[key(w)];
      if (!removedHere) keep(w);
    });
    mine.forEach(function (w) {
      if (!inBase[key(w)]) keep(w);
    });
    return out;
  }

  return {
    DEFAULTS: DEFAULTS,
    SCOPES: SCOPES,
    selectorsFor: selectorsFor,
    MEDIA: MEDIA,
    OCR_IMAGES: OCR_IMAGES,
    OCR_ORIGINS: OCR_ORIGINS,
    ocrImageUrl: ocrImageUrl,
    ocrImageKey: ocrImageKey,
    ocrOriginFor: ocrOriginFor,
    detectSite: detectSite,
    escapeRe: escapeRe,
    compile: compile,
    compileAll: compileAll,
    isValid: isValid,
    invalidWords: invalidWords,
    normalize: normalize,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    updateConfig: updateConfig,
    mergeWords: mergeWords,
    backupPayload: backupPayload,
    BACKUP_KEY: BACKUP_KEY,
    BACKUP_DIR: BACKUP_DIR,
    makeLock: makeLock,
    verifyPassword: verifyPassword,
    isUnlocked: isUnlocked,
    setUnlocked: setUnlocked,
    relock: relock,
    UNLOCK_MINUTES: UNLOCK_MINUTES
  };
})();
