# Building and testing Quiet Feed

Developer notes. The top-level `README.md` is the user-facing one; nothing here needs to go in
front of people who just install the extension.

## Packaging for AMO

```bash
python dev/package.py
```

That writes `quiet-feed.xpi` and **refuses to write it** if anything is wrong: a file the
manifest points at that isn't included, an inline `<script>` (blocked by AMO's default CSP), a
missing `gecko.id`, or a `dev/` file that shouldn't ship.

**Upload that file exactly as it is. Don't re-zip it, and don't zip the project folder.**

AMO needs the extension's *files* at the root of the archive. Zipping the containing directory
puts `manifest.json` one level down, and gets rejected with:

> No manifest.json was found at the root of the extension.

That single mistake also produces two warnings that look unrelated but aren't — because AMO
can't read the manifest, it can't see `gecko.id` either:

- *Inline scripts blocked by default* pointing at `dev/ui-check.html` — the test harnesses use
  inline `<script>`, which is fine for a local page but should never ship. `package.py` excludes
  `dev/` entirely.
- *"storage.sync" can cause issues when loaded temporarily … unless you specify
  `browser_specific_settings.gecko.id`* — the id is present and always has been; AMO just
  couldn't read the manifest to find it.

Fix the packaging and all three go away together.

## Chrome, Edge and Opera

```bash
python dev/package.py chrome
```

That writes `quiet-feed-chrome.zip` from `manifest.chrome.json`. All three browsers are Chromium
and take the same package — it was loaded and exercised in Chrome 153 and Edge 153, which
filtered 20/21 and 26/26 search results respectively.

**Nothing under `src/` is edited to build it, and the `.xpi` is unaffected.** `collect_firefox()`
keeps the Chromium-only files (`CHROME_ONLY`: `compat.js`, `sw.js`, `ocr-bridge.js`,
`offscreen.html`, `offscreen.js`) out of the Firefox package, and the settings and popup pages are
rewritten on the way into the zip rather than on disk. Rebuilding both and diffing the `.xpi`
entry by entry is the check that this stayed true.

What differs:

- **MV2 → MV3**, because Chrome no longer loads MV2 at all. `browser_action` becomes `action`,
  hosts move to `host_permissions`, the CSP becomes an object.
- **`src/compat.js`** aliases `chrome` onto `browser` — and is, measured rather than assumed, a
  no-op in all three: Chrome 153, Edge 153 and Opera 136 each expose their own promise-based
  `browser`, distinct from `chrome`. It is kept as a floor for older Chromium and the other forks,
  not because anything tested needs it.
- **`src/sw.js`** is the service worker entry. MV3 allows a single background file, so it
  `importScripts`es what the Firefox manifest lists under `background.scripts` — except the OCR
  engine, which can't run there (next point).
- **Reading text in images runs in an offscreen document.** A service worker has no DOM and
  cannot spawn the dedicated Worker Tesseract needs. So `src/offscreen.html` loads the engine and
  the unchanged `src/ocr.js`, and `src/ocr-bridge.js` stands in for `ocr.js` inside the worker: the
  same `OCR.read(url, key)`, passed across with a `wf-ocr-run` message. `background.js` is
  unchanged and still makes every check (image URL, per-host permission) before a read reaches the
  document. Details that matter:

  - The document is created on the first read and left open; Chromium allows one per extension,
    so concurrent reads share one `createDocument`. The engines inside still shut down after a
    quiet minute (`ocr.js`), and the read cache survives the service worker being stopped, which
    Chrome does after 30 s idle.
  - A content script's `runtime.sendMessage` reaches the offscreen document too. It answers only
    messages without a `sender.tab`, so nothing gets around `background.js`'s checks.
  - The offscreen document fetches the pictures itself. It is an extension page, so the granted
    optional host permissions let it read them cross-origin, as the Firefox background page does.
  - The manifest needs `offscreen`, the image hosts under `optional_host_permissions` (Chromium
    only grants a host that's listed there), and `'wasm-unsafe-eval'` in
    `content_security_policy.extension_pages`.
  - The settings page says "your browser" rather than "Firefox" where it explains the permission
    prompt (`CHROME_TEXT` in `package.py`, applied on the way into the zip).

- **Backing up automatically is left out.** It's off by default and behind an optional permission.
  `writeBackup()` needs `URL.createObjectURL`, which a service worker does not have. Confirmed
  rather than assumed: it evaluates to `undefined` in the running worker. It isn't reachable in
  this build — the manifest doesn't grant `downloads`, so `browser.downloads` is undefined and
  `canDownload()` answers false before the code path is entered. The build also hides the switch
  from the settings page, so it can't be turned on to no effect. Manual Export still works; it
  runs in the options page, which has a real DOM. (It could move to the offscreen document the
  same way OCR did, with the `BLOBS` reason.)

`check_chrome()` refuses to package on a version mismatch between the two manifests, a missing or
misordered `compat.js`, a granted `downloads` permission, a page whose `<script>` tag or wording
was changed out from under the rewrite, a description over 132 characters, or anything OCR needs
that's missing: an engine file, the `offscreen` permission, `'wasm-unsafe-eval'`, a script
`offscreen.html` loads, or image hosts in `optional_host_permissions` that differ from the Firefox
manifest's.

**Testing OCR in Chrome.** Branded Chrome ignores `--load-extension`, so load the folder with
Developer mode → Load unpacked, turn the feature on in Settings and allow the prompt, then use the
same `r/memes` check as for Firefox (below). Measured in Chrome 155: 2.0 s for the first picture
including engine startup, then ~1.7–2.1 s per picture; the `RICK ASTLEY / NEVER GONNA GIVE YOU UP`
thumbnail reads the same as in Firefox. Automated alternatives: CDP's `Extensions.loadUnpacked`
works over `--remote-debugging-pipe` with `--enable-unsafe-extension-debugging`, but the
permission prompt can't be answered headless, so grant the image hosts by moving them into
`host_permissions` in the unpacked copy.

The two manifests' descriptions differ on purpose. The Chrome Web Store rejects an upload whose
manifest description is longer than 132 characters, which the Firefox one is.
`manifest.chrome.json` uses the short description from `listing-chrome.md`.

## Data collection declaration

AMO requires `browser_specific_settings.gecko.data_collection_permissions` on new submissions.
Quiet Feed declares:

```json
"data_collection_permissions": { "required": ["none"] }
```

which is accurate: nothing is sent to us or anyone else, and the bug report is a `mailto:` the
user composes and sends themselves, with the word list deliberately excluded. Firefox shows this
to users as "doesn't collect any data".

The one network request the extension can make is **Read text in images**, off by default: the
background page fetches a post's picture from the site's own image server (`i.ytimg.com`,
`i.redd.it`, `pbs.twimg.com`, …) so it can read it locally. That is the same picture from the
same server the page has just loaded, sent without cookies or referrer, and neither the picture
nor the text read from it goes anywhere else. It isn't data collection in AMO's sense, and the
declaration stays `"none"`. Nor are the optional automatic backups: they write a file to the
user's own Downloads folder and send it nowhere. If that feature ever sends a picture or its text to any other
service, including a hosted OCR API, this declaration has to change first.

`"none"` has to stand alone — it can't be listed alongside other values. `package.py` checks
both that the key exists and that this rule is respected. If the extension ever does start
transmitting anything, this declaration has to change first.

## Why strict_min_version stays at 115

AMO warns that `data_collection_permissions` only took effect in Firefox 140 (142 on Android),
while `strict_min_version` says 115. That warning is accurate and deliberately ignored.

Raising the floor to 140 would silence it at the cost of locking out every user below 140, for
no functional gain. Older Firefox ignores the unknown key; all that means is those users see no
data-consent prompt, and since the declaration is `["none"]` there is nothing to consent to.

The code's real floor is about Firefox 78 — the newest things it uses are regex lookbehind and
`\p{L}` property escapes. The shipped source is otherwise ES5-style on purpose: no arrow
functions, no optional chaining, no `const`. 115 is already conservative.

The Android half of that warning used to be moot, because without `gecko_android` the extension
was never offered on Firefox for Android. It isn't moot any more. `gecko_android` now sets a
floor of `120.0` — the release where Firefox for Android started installing extensions from AMO
generally, rather than from a curated list — and `data_collection_permissions` only takes effect
there from 142. The trade is identical to the desktop one and resolved the same way: older
Android Firefox ignores the unknown key, and a `["none"]` declaration has nothing to consent to.

Revisit this only if the extension ever declares real data collection. At that point the key
needs to actually be enforced, and a 140 floor starts earning its cost.

## License

MPL 2.0. Two parts, and the second is the one that actually carries it:

- `LICENSE` holds the full text, fetched from mozilla.org rather than retyped, and ships inside
  the package. `package.py` refuses to build without it.
- Every source file carries the Exhibit A notice in its header. That notice is what satisfies
  the licence — it says "if a copy of the MPL was not distributed with this file, you can obtain
  one at ...", so it stands on its own even where the text isn't bundled.

Keep the notice on new source files. In HTML it goes *after* the doctype, so nothing precedes
the doctype and risks quirks mode.

## Signing

```bash
web-ext sign --api-key=... --api-secret=... --channel=unlisted
```

Keys from https://addons.mozilla.org/developers/addon/api/key/ . `web-ext` builds its own
archive correctly, so this route sidesteps the packaging trap entirely.

## Icons

`icons/icon.svg` is the source and is what the popup and settings pages display. The manifest
uses PNGs, regenerated with:

```bash
python dev/make-icons.py
```

## Self-test

```bash
python3 dev/run-tests.py
```

Runs every page below in headless Chrome and prints a line per page, with the failing checks
under it; exits non-zero if anything failed or a page never finished. About 30 s for all 319
checks. Run it before every upload.

- `python3 dev/run-tests.py shorts ocr-check` runs just the pages whose path contains one of
  those; `-j 1` runs them one at a time (default 4) if a timing check ever looks flaky under load.
- It starts its own `dev/serve.py` on a free port, so a server you already have on 8731 doesn't
  get in the way, and a throwaway browser profile, deleted afterwards.
- Browser: `$QF_CHROME` if set (a command line), else `chromium` / `google-chrome` on PATH, else
  the Chrome or Chromium flatpak — through `host-spawn` from inside a distrobox. A flatpak can
  only write under its own `~/.var/app/<id>/`, so the profile goes there.
- **Each page gets its own window, not a tab.** A tab behind another is hidden, and the Shorts
  and text-in-images code deliberately does nothing in a hidden tab, so those checks would fail
  for a reason that isn't a bug.
- Standard library only. It speaks the DevTools protocol over a small built-in WebSocket client.

By hand instead:

```bash
python3 dev/serve.py
```

Then visit these — every check should say PASS:

| Page | Covers |
| --- | --- |
| `/dev/self-check.html` | Hiding, layout, silencing, matching, scopes, hosts, storage, merging, hashing, glued text, visibility leaks, timestamps, hover cards, community status, handles, phrases and their punctuation (123) |
| `/dev/shorts-check.html` | Shorts player, desktop: skip once, two matches in a row, no double skip on a stale title, next Short not left paused, a handle containing a blocked word, skipping upwards on the way back up, covered at the top, Show, counts, captions, a link to another Short, skipped again on the way down (26) |
| `/dev/shorts-check.html?mobile=1` | The same against m.youtube.com's player shape (26) |
| `/dev/shorts-check.html?late=1` | A word added while its Short is on screen: that Short is skipped, not left "Hidden"; scrolling up, a settings change keeps the direction (5) |
| `/dev/shorts-check.html?hidden=1` | A Short opened in a background tab: covered, Next not pressed while hidden, skipped once shown, after the player takes Next (6) |
| `/dev/shorts-check.html?hidden=1&slow=1` | The same with a player that ignores the first press after being shown: pressed again (6) |
| `/dev/shorts-check.html?ocr=1` | Text in images in the Shorts player, reader stubbed: first frames read, current first then two ahead, a Short skipped for its frame alone, saying so (7) |
| `/dev/shorts-check.html?ocr=1&blur=1` | The same with blur until read: covered and paused until its frame is read (3) |
| `/dev/ui-check.html` | Popup: fold the list, scope pills, delete buttons, report link, edits from another window (25) |
| `/dev/ui-check.html?collapsed=1` | Popup reopened folded, then folded again (5) |
| `/dev/ui-check.html?invalid=1` | Broken entries flagged, refused on entry, commas vs regexes (11) |
| `/dev/ui-check.html?locked=1` | Popup locked: every edit blocked, then unlocking (12) |
| `/dev/ui-check.html?options=1` | Settings: password flow, bug report, edits from another window (30) |
| `/dev/ocr-check.html` | Text in images, engine stubbed: blur from the first frame, reads in viewport order, hide on image text, swapped thumbnails re-blur, Show unblurs, CSS/JS prefix agreement (31) |
| `/dev/ocr-check.html?denied=1` | Setting on but Firefox's permission missing on this device: no blur, no reads (5) |
| `/dev/ocr-check.html?off=1` | Setting off: no blur, no reads (5) |
| `/dev/ocr-engine.html` | The real bundled engine on generated memes, thumbnails and screenshots — slow on first load (7). The meme's caption is shrunk to fit: without Impact installed (most Linux systems) the fallback font is wider, the top line ran off both edges, and the check failed for a test-picture reason |

`ui-check.html` loads the real `popup.html` / `options.html` markup and the real scripts against
an in-memory storage stub, so the pages are exercised as shipped rather than re-implemented. The
stub copies values in and out and broadcasts `storage.onChanged`, as real storage does — sharing
object references would let a page change the "stored" list without saving, hiding exactly the
kind of bug below.

Three conventions worth keeping:

- **Visibility checks assert `getComputedStyle(el).display` and rendered height, never
  `el.hidden`.** Folding the list once shipped broken because `ul { display: flex }` outranks the
  browser's built-in `[hidden] { display: none }` — so `el.hidden = true` was set and silently
  ignored, and a test asserting `el.hidden === true` passed anyway.
- **Tests wait for the filter to act rather than sampling at a fixed moment.** Hiding is driven
  by a MutationObserver with a ~1.2s backstop sweep, so "not yet" and "never" look identical at
  any single instant. Sampling made these checks flaky.
- **Never save a page's copy of the config — apply a change to fresh storage.** The popup and
  settings page each load the config when they open. Saving that copy meant whichever saved last
  erased the other's changes: an open settings tab could wipe words added from the popup with an
  unrelated click. Every change now goes through `WF.updateConfig(fn)`, which reads, applies and
  writes in order; bulk edits of the textarea are a three-way `WF.mergeWords`; both pages refresh
  when another window writes, without touching unsaved textarea edits.

## Reading text in images

Off by default. The pieces:

- `src/content.js` asks for pictures to be read, nearest the screen first, two at a time, and
  adds what comes back to the post's text, so matching needs no special case.
- `src/background.js` checks the image URL and the permission, then hands it to `src/ocr.js`.
- `src/ocr.js` fetches the picture, upscales it, and runs two Tesseract passes in parallel: the
  picture itself, and a stencil of its bright pixels, which is what catches outlined white or
  yellow meme captions. Both get a 40px white margin first: a caption touching the edge of the
  picture otherwise throws Tesseract's layout analysis off — one real meme read *nothing* without
  it and every word at 96% with it. It keeps words at 60%+ confidence and drops lone one- or two-letter
  scraps.
- `src/hidden.css` blurs unread pictures, by `[src^=…]` prefix, inside the post groups switched
  on.

Things that will bite if they drift:

- **`OCR_IMAGES` in `common.js` and the prefixes in `hidden.css` must agree**, and so must each
  CSS group's selectors and `SCOPES`. A picture the CSS blurs but the script never reads stays
  blurred for good. `ocr-check.html` compares them; run it after touching either.
- **The permission is per device; the setting syncs.** "On" can arrive from another machine
  where it was allowed. The content script asks the background first (`wf-ocr-ready`) and blurs
  nothing until it hears yes, and the settings checkbox shows *on and allowed*, not just the
  stored value.
- **`permissions.request` must be the first thing in the click handler.** Firefox drops the
  prompt if anything is awaited before it.
- **Adding an image host strands existing users.** Firefox never grants a newly added optional
  permission by itself, so reads are permission-checked per host (`WF.ocrOriginFor`), a missing
  host only leaves that host's pictures unread, and Settings offers **Allow it**. Add the host to
  `OCR_IMAGES`, `OCR_ORIGINS`, `optional_permissions` in the manifest, and every group rule in
  `hidden.css` — `ocr-check.html` fails if the CSS and script disagree.
- **The CSP needs `'wasm-unsafe-eval'`** or the engine's WebAssembly won't compile. `package.py`
  checks for it.
- **Key reads by `ocrImageKey`, not the URL.** Reddit shows each picture twice (the picture and a
  blurred backdrop copy) from two URLs; keyed by media ID, it is read once.

Vendored engine files and how to update them: `src/vendor/tesseract/README.md`. `package.py`
refuses to build if any of the four files the engine loads by URL is missing.

**Testing against real sites.** The self-test pages stub the background. For the real thing,
load the folder as a temporary add-on (`about:debugging` → This Firefox → Load Temporary Add-on →
`manifest.json`), turn the feature on in Settings, and add a few words common in memes (`when`,
`me`, `you`) on `reddit.com/r/memes`. Posts should be hidden with *"…" in an image* within a
second or two of scrolling into view. Measured on Firefox 156: 0.65–1.5 s per picture.

## Shorts

The Shorts player is handled by `scanShort()` in `src/content.js`, not by `SCOPES`: a matching
Short is covered, paused and skipped (the Next button is clicked), rather than hidden in place.
It runs under the `youtubeVideos` switch. Everything below was measured on youtube.com and
m.youtube.com, logged out, and `shorts-check.html` replays it.

- **One renderer, one `<video>`, for every Short.** Desktop (`ytd-reel-video-renderer` inside
  `ytd-shorts`) and mobile (`shorts-video` inside `shorts-page`) each move a single renderer into
  whichever slot is on screen. Never tear its video out — that is the player for the rest of the
  session. Pause it, and hold it paused with a `play` listener.
- **The URL leads the text.** The address changes ~150ms (sometimes 500ms+) before the
  renderer's title does, so the next Short briefly wears the skipped one's title. Nothing is
  decided until the renderer's text differs from what the previous Short was decided on —
  comparing words only, because blank text nodes drop out and come back a beat earlier, and
  aria-labels flicker through in-between values. Exact comparison caused double skips.
- **`emptied` is the real moment of leaving.** The player loads the next Short into the same
  `<video>` (`emptied`, then `play`) ~70ms before the URL changes. The pause guard lets go there,
  and nothing more is done to that Short; a scan landing in that gap once re-paused the next
  Short and left it frozen.
- **The slot behind the renderer holds the Short's thumbnail** (`frame0.jpg` as a background),
  so the placeholder is opaque there, unlike the feed's.
- **Captions live inside the renderer** (`.ytp-caption-window-container`, inside `ytd-player` /
  `player-component`) and change every second. `PLAYER_SEL` keeps player chrome out of every
  post's text.
- **A Short can link to a different Short** under its title (`yt-reel-carousel-view-model`, a
  ▶ chip with the other Short's title, on desktop and mobile alike). `LINKED_SEL` keeps it out
  of the text, or a word in the linked title hid the Short carrying it.
- **Text in images reads each Short's first frame**, `i.ytimg.com/vi/ID/frame0.jpg`, since the
  video can't be read. On eleven Shorts it read burned-in captions at least as well as the
  full-size thumbnail (`oardefault.jpg`, up to 1080×1920), in ~0.5s against ~0.8s. Desktop puts
  that frame behind every slot as an inline `background-image`, upcoming Shorts included, which
  is how the next two are found and read ahead. Mobile's carousel showed no such URLs, so there
  only the Short on screen is read, its URL built from the ID in the address.
- **Skipped the way you're going, every time.** Next on the way down, Previous on the way back
  up. Skipping only the first time (and covering a Short you came back to) made a blocked Short a
  wall: scrolling up stopped there, and once passed by hand it was never skipped again on the way
  down. Direction comes from `shortsOrder`, the order Shorts were first shown in, since the player
  only adds new ones at the bottom; it is cleared when you leave the player. At the top (position
  0, reached going up) there is nothing to skip to, so it stays covered under "Hidden" with Show,
  as does a Short the player refused to leave after `SHORT_TRIES` (3) presses. Measured on
  youtube.com in Chrome 155, with the buttons and with the arrow keys: up from C onto blocked B
  lands on A, down from A lands on C, ~1 s after arriving.
- **A settings change re-decides the Short on screen** (`resetShorts()`), keeping its place and
  direction, so a word added while scrolling up doesn't send you back down, and a skip already
  under way carries on rather than starting a second one. It used to drop the Short and come back
  to it as a repeat — "Hidden", never skipped — which is exactly what adding a word from the popup
  while watching the Short it matches did.
- **Not in a background tab.** The player ignores Next in a hidden tab, and for a while after it is
  shown: measured in Chrome 155, a player loaded in the background ignored a press 0.8 s after the
  tab came to the front and took one at 0.9 s, with no event marking the change. Pressing it while
  hidden left the Short covered for good. So `scanShort()` waits until the tab is shown
  (`visibilitychange` rescans) plus `SHORT_SHOWN_MS` (1.2 s), and a press that hasn't moved the
  player after `SHORT_RETRY_MS` (2.5 s) is repeated. A press that worked has always moved on by
  then (`emptied` ~0.7 s, the URL ~0.75 s), so the retry can't skip twice.
- Next is `#navigation-button-down button` on desktop and the second button of
  `.ytShortsCarouselShortsA11yNav` on mobile — both found by structure, not by their
  English labels.

## Site selectors

`SCOPES` in `src/common.js` lists the post containers, grouped by the switch that controls them —
`youtubeVideos`, `youtubeComments`, `redditPosts`, `redditComments`, `x`. Splitting a site
further means adding a group there and a toggle in the two UIs; nothing else changes, because
the content script just asks `selectorsFor(site, cfg)` for whatever is currently switched on.

These are the part most likely to rot when a site reshuffles its markup — if something stops
being hidden, that list is where to look.

Two traps, both learned the hard way:

- **Too blunt.** Matching a whole shelf or section because one video inside it matched hides far
  more than intended. Selectors are deliberately leaf-ish.
- **Too specific.** X's signed-in timeline puts `data-testid="tweet"` and `role="article"` on
  each post, but logged-out X — the only state a visitor without an account ever sees — renders
  them as a plain `<article>`. Selecting on those attributes matched nothing for exactly the
  people most likely to install this. A test now asserts no X selector depends on a
  signed-in-only attribute.

## Mobile

Runs, and checked on Firefox for Android in an emulator rather than reasoned about.

**YouTube needed selectors.** `m.youtube.com` really is a different app: the same video is
`ytm-video-with-context-renderer` in search results and in a watch page's related list, but
`ytm-compact-video-renderer` in a channel grid, wrapped in `ytm-rich-item-renderer`. Comments
keep the desktop two-level shape as `ytm-comment-thread-renderer` and `ytm-comment-renderer`, in
a sheet that slides over the video. All of them sit in the same `SCOPES` groups as their `ytd-*`
counterparts, so one toggle covers a phone and a laptop alike.

`ytm-media-item` is deliberately absent. It sits inside every one of those containers, on every
surface checked and never once on its own, so listing it would only re-hide a hidden box.

**Reddit and X needed nothing.** Both serve a phone the same markup they serve a desktop —
`shreddit-post` and a plain `<article>` — which was confirmed by rendering each at 414px and at
1024px and diffing the structure. The only thing a narrow viewport turned up was
`reddit-pdp-right-rail-post`, the recommendation list on a post page, which the desktop
selectors had been missing too.

**Distribution.** `browser_specific_settings.gecko_android` sets `strict_min_version` to
`120.0`, the release where Firefox for Android began installing extensions from AMO generally
instead of from a curated list. Without that key AMO never offers the extension on Android at
all, however well it runs there — and the gap is invisible in development, because
`web-ext run --target firefox-android` installs over the remote debugger and never consults AMO.
The next upload goes through review as an Android-compatible listing.

One caveat on all of the above: every surface was checked logged out. Signed-in feeds —
YouTube's home and subscriptions, X's timeline — could not be reached, and X's `cellInnerDiv`
and `data-testid` selectors only exist in that state.

Firefox for iOS supports no extensions at all, so that platform is closed regardless.
