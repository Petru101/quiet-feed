/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Stand-in WebExtension APIs, so the real popup, settings page and content
   script run in an ordinary page for the store screenshots. Configured from
   the page's query string:

     words=a,b,c    the word list
     reveal=1       preview mode on
     statsFrom=id   answer the popup's "what's hidden here?" from the sibling
                    iframe with this id, the way the content script in a real
                    tab would, so its counts are what the pictured feed shows */

(function () {
  'use strict';

  var q = new URLSearchParams(location.search);
  var words = (q.get('words') || '').split(',')
    .map(function (w) { return w.trim(); })
    .filter(Boolean);

  var backing = {
    local: { wfConfig: { enabled: true, words: words, revealAll: q.get('reveal') === '1', savedAt: 1 } },
    sync: {}
  };

  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  function area(name) {
    return {
      get: function (keys) {
        var out = {};
        (typeof keys === 'string' ? [keys] : (keys || [])).forEach(function (k) {
          if (k in backing[name]) out[k] = clone(backing[name][k]);
        });
        return Promise.resolve(out);
      },
      set: function (obj) {
        Object.keys(obj).forEach(function (k) { backing[name][k] = clone(obj[k]); });
        return Promise.resolve();
      },
      remove: function (k) { delete backing[name][k]; return Promise.resolve(); }
    };
  }

  function siblingStats() {
    var frame = parent.document.getElementById(q.get('statsFrom'));
    if (!frame) return null;
    var counts = {};
    var total = 0;
    frame.contentDocument.querySelectorAll('[data-wf-state="hidden"],[data-wf-state="marked"]')
      .forEach(function (el) {
        total++;
        var w = el.dataset.wfWord || '';
        counts[w] = (counts[w] || 0) + 1;
      });
    return { site: 'reddit', active: true, total: total, counts: counts };
  }

  window.browser = {
    storage: {
      local: area('local'),
      sync: area('sync'),
      onChanged: { addListener: function () { } }
    },
    runtime: {
      onMessage: { addListener: function () { } },
      openOptionsPage: function () { },
      getManifest: function () { return { name: 'Quiet Feed: Hide Posts by Keyword', version: '2.0' }; },
      getURL: function (path) { return path; }
    },
    tabs: {
      query: function () { return Promise.resolve(q.get('statsFrom') ? [{ id: 1 }] : []); },
      // Late enough for the feed beside it to have been filtered.
      sendMessage: function () {
        return new Promise(function (resolve) { setTimeout(function () { resolve(siblingStats()); }, 900); });
      },
      create: function () { return Promise.resolve({}); }
    }
  };

  window.close = function () { };
})();
