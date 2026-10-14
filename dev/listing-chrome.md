# Chrome Web Store listing copy

Everything the Chrome Web Store asks for, written out so submitting is paste-and-click. The
AMO copy in `listing.md` mostly doesn't fit: Chrome's short description is 132 characters
against AMO's 250, and Chrome asks for things AMO never does — a single-purpose statement, a
justification per permission, and a data-handling certification.

Covers Chrome, Edge and Opera. Edge and Opera have their own stores with near-identical forms;
the same text works, though each wants its own developer account.

---

## Before any of this works

Three steps that have to be done by a person, in this order:

1. **Register as a Chrome Web Store developer** — a one-time $5 USD fee, paid to Google, on the
   account that will own the listing. There is no way around it and no free tier.
2. **Accept the Chrome Web Store Developer Agreement** — a contract between you and Google.
3. **Verify the publisher email** on the account.

Only then does the "Add new item" button do anything.

---

## Package

`quiet-feed-chrome.zip`, from:

```bash
python dev/package.py chrome
```

Upload the zip exactly as built — the store wants the extension's files at the archive root,
same rule as AMO.

---

## Store listing tab

**Name** (75 max)

```
Quiet Feed: Hide Posts by Keyword
```

**Short description** (132 max — one line, no wrap; the AMO summary is 233 and won't fit)

```
Hide whole posts containing your chosen words on YouTube, Reddit and X. Hidden in place: feeds don't reload, video stays silent.
```

(128 characters. Anything you rewrite, count it — the store truncates silently rather than
warning you.)

The same text is the `description` in `manifest.chrome.json`, where the 132 limit is enforced:
the store rejects an upload whose manifest says more. Change one, change the other.
`package.py chrome` refuses a manifest description over 132.

**Detailed description** — the AMO description in `listing.md` transfers almost unchanged. Two
edits before pasting:

- Every "Firefox" becomes "Chrome". There are several, including "Firefox will ask to let Quiet
  Feed…" in the permissions paragraph and "follows your Firefox account if you use Firefox Sync"
  which becomes Chrome Sync.
- **Cut automatic backups** wherever they come up. That feature is not in the Chromium build (see
  `PACKAGING.md`), and describing a feature the package doesn't ship is the kind of mismatch that
  gets a listing rejected. "Read text in images" stays: the Chromium build has it.

**Category:** Productivity → Workflow & Planning

**Language:** English

**Screenshots:** `dev/shots/out/shot-1.png` … `shot-4.png`. Already 1280×800, which is exactly
what the store wants — no resizing needed. Minimum one, maximum five.

**Store icon:** `icons/icon-128.png`.

---

## Privacy tab

This is the part with no AMO equivalent, and the part most likely to bounce a submission.

**Single purpose**

```
Quiet Feed hides posts on YouTube, Reddit and X that contain words the user has chosen. Every
part of the extension serves that one purpose: the word list, the per-site switches, and the
placeholder that preserves a hidden post's space so the feed does not reload.
```

**Permission justifications** — one is required for each, and "it needs it" gets rejected.

`storage`

```
Stores the user's word list and settings. It is kept in chrome.storage.sync so the list follows
the user between their own signed-in Chrome installations, and mirrored to chrome.storage.local
so the extension still works when sync is unavailable. Nothing is sent anywhere else.
```

Host permissions — `*://*.youtube.com/*`, `*://*.reddit.com/*`, `*://*.x.com/*`,
`*://*.twitter.com/*`

```
The content script reads the text of posts on these four sites in order to compare it against
the user's word list and hide the posts that match. Reading the page is the entire function of
the extension. It runs on no other sites. Its only network requests are for post pictures, and
only with the optional "Read text in images" feature switched on (see the optional host
permissions below).
```

`offscreen`

```
Used only by the optional "Read text in images" feature, which is off by default. It reads the
text in post pictures so they can be checked against the user's word list. The OCR engine
(Tesseract.js and its English model, bundled in the package) needs a Web Worker and a canvas.
An MV3 service worker can't provide either, so the engine runs in an offscreen document created
with the WORKERS reason. The document is only created when a picture needs reading, shows
nothing, and only answers requests from the extension's own service worker. Pictures are read on
the user's device; no picture or text is sent anywhere.
```

Optional host permissions — `https://i.ytimg.com/*`, `https://i.redd.it/*`,
`https://preview.redd.it/*`, `https://cf.preview.redd.it/*`, `https://external-preview.redd.it/*`,
`https://pbs.twimg.com/*`

```
Requested only when the user turns on "Read text in images" in Settings, and handed back when
they turn it off. These are the image servers YouTube, Reddit and X already load post pictures
from. The extension downloads the same picture again, without cookies, so the bundled OCR engine
can read its text on the device and compare it with the user's word list. Neither the picture nor
the text is sent anywhere.
```

**Are you using remote code?**

```
No. All JavaScript and WebAssembly in this extension is included in the package, including the
OCR engine (Tesseract.js 7.0.0 and its English model), which loads only from the extension's own
files.
```

(The vendored engine is unmodified npm release files; `src/vendor/tesseract/README.md` lists the
sources and SHA-256 hashes, which is what to point a reviewer at.)

**Data usage** — tick nothing, then certify all three statements.

The extension reads the text of posts — and, with "Read text in images" on, the text in their
pictures — locally in order to decide whether to hide them, and transmits none of it. Reading page content in the browser is not collection; collection is
sending it somewhere. Nothing leaves the device, there is no server, and there is no analytics.

> **Read this one yourself before you tick it.** The data certification is a declaration to
> Google about your own extension, and getting it wrong is a policy violation rather than a
> typo. The reasoning above is sound as far as the code goes, but the box is yours to tick.

**Privacy policy URL:** not required while nothing is collected. If the form insists, the
README section on what the extension stores is the honest thing to point at.

---

## After submitting

First review on a new developer account is typically slower than later ones. A listing that
requests host permissions for four sites tends to draw a closer look, which the single-purpose
statement and the permission justifications above are written to satisfy up front.
