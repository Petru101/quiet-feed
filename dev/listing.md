# AMO listing copy

Paste into the Summary and Description fields when submitting. Kept here so it's versioned
alongside the extension and easy to revise.

---

## Summary (AMO "Summary" field — 250 char limit)

> Hide whole posts containing words you choose, on YouTube, Reddit and X. Hides them in place
> instead of deleting them, so feeds don't spiral into reloading — and silences video in hidden
> posts, so nothing plays where you can't see it.

(228 characters.)

---

## Description

**You give it words. It hides any post containing one — the whole post, not just the word.**

Works on YouTube (videos and comments), Reddit (posts and comments) and X, signed in or not.
Each of those is a separate switch, so you can filter what you're offered to watch and leave the
discussion under it alone, or the reverse. In YouTube's Shorts player, where one video fills the
screen, a matching Short is skipped instead.

**It hides posts rather than deleting them, and that matters more than it sounds.**

Most keyword blockers remove the post from the page. Two things go wrong when they do. On
YouTube the feed gets shorter, so the site loads more to fill the gap, some of that gets removed
too, and you sit watching it loop. And a hidden video keeps playing — hiding something visually
doesn't stop its audio.

Quiet Feed keeps the post exactly where it was, at exactly its old size, showing a small
placeholder you scroll past. Nothing reloads. The video inside it is torn out entirely, so it
can't make noise from behind a placeholder.

**Why I made it**

I built this for myself. I'd got into the habit of scrolling past things that seemed designed to
make me angry, and I didn't much like what it was doing to my mood. Two dozen words later my
feeds got a lot quieter, and I've been glad of it since.

That's my experience, not a claim about yours — what you get out of it depends entirely on what
you put in the list and what your feeds look like to begin with. It's free, it takes a minute to
try, and one click turns it off.

**It has no opinion about what you should hide**

There is no preloaded list, no suggested words, nothing political baked in. It starts empty and
does nothing at all until you add something. The list is yours.

**What it doesn't do**

No account, no sign-up. It makes no network requests of any kind — it never talks to a server,
mine or anyone else's — and collects no data whatsoever. Your word list lives in your browser,
and follows your Firefox account if you use Firefox Sync.

**Details**

- Plain words match whole words, plus plurals and possessives: `cat` catches "Cat's" but not
  "catapult". Several words on a line match as a phrase. Regular expressions work too.
- **Preview mode** outlines matches instead of hiding them, so you can tell whether a new word
  is too broad before you commit to it.
- Any hidden post has a **Show** button, if you want to see that one after all.
- An optional password can sit in front of the list, if you'd rather not be able to edit it on
  impulse. Off by default.
- Export and import your list as a file.

**If something slips through**

Sites rearrange their markup constantly, and when they do, a post that should be hidden won't
be. There's a **Report a bug** link in the extension — that's usually a quick fix at my end, and
far more use to me than a star rating. The report never includes your word list.

---

## Notes on the tone, if you want to adjust it

- The origin story stays in the past tense and first person, and is followed immediately by "not
  a claim about yours". That's what keeps it from reading as a health claim.
- No "reclaim your feed", "take back control", "digital wellbeing". That vocabulary is what makes
  this category of extension sound preachy.
- "It has no opinion about what you should hide" is doing real work — it's the line that stops
  the whole thing reading as a political statement, and it's true: the word list ships empty.
- The last section exists to catch disappointed users before they leave a one-star review.

## Notes to Reviewer (v2.7 — paste into the "Notes to Reviewer" box)

When AMO asks **"Do you need to submit source code?"**, answer **No**. None of Quiet Feed's own
code is compiled, minified or bundled; what ships is what's in the repository. The only
machine-generated files are an unmodified third-party library, documented below as AMO's
third-party library policy asks.

```
No build step: all of Quiet Feed's own code (src/*.js, *.html, *.css) is hand-written and
shipped as-is.

New in 2.7, all in src/common.js: a phrase of several words now ignores the punctuation between
its words, and "&", "+" and "and" stand for each other (or can be missing), so "mitchell & webb"
also matches "Mitchell and Webb", and text read from a picture, where the OCR drops a lone "&".
Punctuation inside a word ("AT&T", "c++") still has to match. No new permissions, and no change to
what is collected: nothing.

Bundled third-party library, unchanged since 2.1: the optional "Read text in images" feature
(off by default) bundles Tesseract.js, unmodified, in src/vendor/tesseract/ — nothing is loaded
from a CDN at run time. Files, originals and readable source:

- tesseract.min.js, worker.min.js (+ their .LICENSE.txt files, LICENSE.txt)
  Original: https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz  (dist/)
  Source:   https://github.com/naptha/tesseract.js/tree/v7.0.0
- tesseract-core-simd-lstm.wasm.js  (Emscripten build of Tesseract; the WebAssembly is embedded)
  Original: https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz  (package root)
  Source:   https://github.com/naptha/tesseract.js-core/tree/v7.0.0
- eng.traineddata.gz  (English language model, data only)
  Original: https://registry.npmjs.org/@tesseract.js-data/eng/-/eng-1.0.0.tgz  (4.0.0_best_int/)
  Source:   https://github.com/naptha/tessdata/tree/gh-pages/4.0.0_best_int

SHA-256 of each file, and why these variants: src/vendor/tesseract/README.md.

Why 'wasm-unsafe-eval' in the CSP: the OCR engine is WebAssembly and can't compile without it.
No other eval is used.

Permissions, all optional and requested only when the user ticks the matching setting:
- Image hosts (i.ytimg.com, i.redd.it, preview.redd.it, cf.preview.redd.it,
  external-preview.redd.it, pbs.twimg.com): "Read text in images" fetches a post's picture —
  the one the page is already showing — so the background page can read it locally. Removed
  again when the setting is turned off.
- downloads: "Back up automatically" saves the user's own settings file to their Downloads
  folder. Removed again when turned off.

Nothing is sent to any server of ours or anyone else's; data_collection_permissions stays "none".
To test: Settings > Images > Read text in images, add the word "when", open reddit.com/r/memes.
Posts whose picture contains the word are hidden with "Hidden · 'when' in an image".
```
