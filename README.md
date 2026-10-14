# Quiet Feed

**Quiet Feed: Hide Posts by Keyword** — a Firefox extension that hides posts containing words
you choose, on YouTube, Reddit and X.

It talks to no server of its own anywhere — there is nothing to collect and nowhere for it to
go. The one exception is optional and off by default: **Read text in images** loads the pictures
a post is already showing, from the site's own image servers, so it can read them on your
machine (see below).

Your settings are kept in Firefox's own sync storage, so they follow your Firefox account to
your other devices, with a copy always held on the machine you're using. That is the browser's
mechanism, not a server of ours. If you'd rather nothing left the machine at all, sign out of
Firefox Sync — the extension keeps working from the local copy.

## Why hiding instead of removing

Extensions like **You're Fired!** call `element.remove()` on a match. That works, but it has
a side effect: the feed gets shorter, YouTube's infinite scroll notices the page no longer
fills the viewport, loads more content to compensate, some of that gets removed too, and you
sit through a loading loop.

Quiet Feed keeps the element in the page and keeps its layout box, so the feed never gets
shorter and nothing tries to refill it. You scroll past an empty placeholder instead.

## Why hidden videos still stay silent

Hiding a post visually does **not** stop a `<video>` inside it — that's the one real advantage
removal had. So the two concerns are handled separately:

- The **post** is hidden but kept (`visibility: hidden` plus a pinned `min-height`).
- The **media** inside it — `<video>`, `<audio>`, `<iframe>`, and Reddit's `shreddit-player`
  wrappers — is torn out and replaced by an invisible spacer of exactly the same size.

Silence is guaranteed by the same mechanism removal relied on (a detached media element cannot
play), while the spacer means the layout doesn't shift, so the reload loop never starts.

One detail worth knowing if you ever extend this: Reddit keeps its `<video>` inside an **open
shadow root**, so `document.querySelectorAll('video')` will not find it. The walker in
`src/content.js` descends `element.shadowRoot` as well as the light DOM.

The trade-off: because silencing is destructive, clicking **Show** on a hidden post brings back
its text and images but not its video — reload the page if you want to watch it.

## Shorts

Shorts in feeds, search and the sidebar are hidden like any other video. The Shorts player
itself (`youtube.com/shorts/…`, and `m.youtube.com` on a phone) works differently, because one
Short fills the screen and a placeholder there would just be a blank screen: a matching Short is
**skipped**. It is covered and paused for the half-second that takes, so you don't see or hear
it, then the player moves on to the next one.

- It's skipped the way you're scrolling, every time it comes up: down to the next Short on the
  way down, up to the one before on the way back up. So a blocked Short never gets in the way of
  going back.
- The very first Short, reached by scrolling back up, has nothing above it to skip to. It stays
  covered and paused there, with a **Show** button that plays it.
- The video is paused, never torn out, so **Show** works here, unlike in a feed. The Shorts
  player uses a single `<video>` for every Short, so tearing it out would break the player.
- A Short opened in a background tab is skipped when you switch to the tab, a second or so
  after it appears; until then it stays covered and paused.
- **Preview mode** outlines a matching Short and lets it play, without skipping.
- It's part of the YouTube **Videos** switch. The text shown with a Short — title, channel,
  hashtags — is matched; the player's subtitles are not. With **Read text in images** on, so is
  text burned into the video itself (see below).

## Using it

Click the toolbar icon:

- Type a word or phrase and press Add. Commas separate multiple entries.
- Every word is listed as a chip; the × removes it. A badge shows how many posts that word is
  hiding on the page you're looking at.
- **Words (n)** folds the list away when it gets long, and remembers that you folded it.
  Adding a word unfolds it so you can see what landed.
- **Runs on** — five independent pills: YouTube **Videos** / **Comments**, Reddit **Posts** /
  **Comments**, and **X**. Turn either Comments off to filter what you're offered and leave the
  discussion under it alone. Same settings as on the settings page, just reachable in one click,
  and none of them touch your word list.

  X is a single switch rather than two: unlike the others it renders a reply with exactly the
  same markup as a post, so there is nothing to tell them apart by. Covers both `x.com` and
  `twitter.com`, signed in or not, plus trends and quote/link cards.
- The **On/Off** switch disables everything without losing your list.
- **Preview mode** dims and outlines matches instead of hiding them — useful when you're
  working out whether a new word is too broad.
- **Report a bug** opens the settings page at a prefilled report. Sites change their markup
  constantly, so a missed post is usually a selector that needs updating — and that is a
  five-minute fix if someone says so.

### Locking the list (optional)

Off unless you turn it on, in Settings → Password. Once on, changing the list, the site pills,
the on/off switch or preview mode asks for a password first — in the popup and on the settings
page. Everything stays readable; only editing is gated. Unlocking lasts about five minutes, so
a run of edits doesn't mean retyping it.

Be clear-eyed about what this is: **a speed bump against your own impulse to edit the list, not
security.** The password is never stored — only a salted PBKDF2-SHA256 hash — and there is no
recovery.

**Settings** (right-click the icon → Manage Extension → Preferences, or the link in the popup)
has bulk editing of the list, the hide style, per-site on/off, and JSON export/import.

### Automatic backups (optional)

Firefox deletes an extension's storage the moment the extension is removed, so a list built
over months can vanish with one wrong click in `about:addons` or `about:debugging` (reload keeps
it; *remove* doesn't). Settings → Backup → **Back up automatically** guards against that. Off by
default; turning it on asks Firefox for permission to save downloads, and turning it off hands
that back.

- A few seconds after the list or settings change, the same file **Export** makes is saved to
  `Downloads/Quiet Feed backups/quiet-feed-YYYY-MM-DD.json`. One file per day, so every earlier
  day is left as it was. Restore one with **Import**.
- **A backup never makes things worse.** An empty list is never saved — that's what a wiped
  install looks like — and a shorter list never overwrites a longer one: it goes to its own
  file stamped with the time instead.
- The files hold the same as Export: your list and settings, never your password lock. Each
  backup briefly shows in the downloads panel, then is cleared from the download history; the
  file itself stays.

### Reporting a problem

Settings → **Report a problem** builds a message with the version, the browser string, which
scopes are switched on, and how many words are in the list.

**It never includes the words themselves.** What someone chooses to filter can be genuinely
personal — health, names, an ex, politics — and none of that belongs in a stranger's inbox to
diagnose a missed selector. The counts are what's diagnostic anyway, the whole message is shown
before anything is sent.

Reporting stays available while the list is password-locked, since it changes no settings.
There's a **Copy details** button for anyone without a mail app configured.

### Where your settings live

In `storage.sync`, mirrored to `storage.local` on every save. The mirror is not belt-and-braces
for its own sake: sync has an 8KB-per-item quota and can be unavailable entirely, and a word
list is the sort of thing people spend months building. If a sync write fails, the change is
kept locally and the settings page says so rather than losing it quietly.

Because either copy can be the fresher one — you edited on a second device, or a sync write
failed here — each carries the time it was written, and the newer one wins on load. An install
that predates syncing has a local copy only; it loads from there and syncs on the next save.

### How words match

| You type | It matches |
| --- | --- |
| `cat` | "Cat", "cats", "Cat's" — but not "catapult" |
| `the office` | the phrase, ignoring extra whitespace and punctuation between the words |
| `mitchell & webb` | "Mitchell & Webb", "Mitchell and Webb", "Mitchell + Webb", "Mitchell - Webb" |
| `ad` | "ad", "#ad", "ad-supported" — but not "@something-ad-nonsense" or "some_ad_guy" |
| `something-ad-nonsense` | that whole handle, "@something-ad-nonsense" |
| `/cat(s\|nip)/` | anything the regular expression matches |

A handle (`@name`, Reddit's `u/name` and `r/name`) counts as one word, however it's punctuated:
only the whole handle matches it, not a piece of it. Without that, one short word could hide
everything a channel posts, since a Short always shows its channel's handle. An underscore
joins words anywhere.

In a phrase, `&`, `+` and `and` stand for each other, and can be missing altogether: text read
from a picture loses a lone `&`. A symbol inside a word, as in `AT&T` or `c++`, has to be there.

Matching is always case-insensitive. Switch **Matching** to "anywhere in the text" in settings
if you'd rather `art` also caught "particle".

Commas separate several entries at once — except when the whole entry is a regex, since a
quantifier like `{2,4}` contains one and splitting there would produce two pieces of nonsense
that both look like ordinary words.

An entry that can't be compiled (an unbalanced regex, say) is **flagged rather than silently
ignored**: the popup refuses to add it and says why, and any such entry already in the list —
from an import, for instance — is struck through and marked. Without that, a typo looks exactly
like a word that simply isn't coming up.

Text is read from the whole post container, so a match on the title, body, channel name,
subreddit or flair all hide the post.

### Reading text in images (optional)

Sometimes the title says nothing and the whole point of the post is written in the picture — a
meme, a screenshot of a headline, a thumbnail slogan. Settings → **Images → Read text in images**
checks that text against the same list, with the same matching rules. A post hidden this way
says so: *Hidden · "word" in an image*.

- **Off by default.** Turning it on asks Firefox for permission to load pictures from
  `i.ytimg.com`, `i.redd.it`, `preview.redd.it`, `cf.preview.redd.it`, `external-preview.redd.it`
  and `pbs.twimg.com`. Turning it off hands that permission back. Nobody who leaves it off ever
  grants it. If an update adds a server (Reddit started serving some people's pictures from
  `cf.preview.redd.it`), Firefox doesn't allow it by itself: Settings shows an **Allow it** button,
  and until then only pictures from that one server go unread.
- **Everything happens on your computer.** The OCR engine ([Tesseract.js](https://github.com/naptha/tesseract.js))
  and its English model ship inside the extension; nothing is downloaded at run time and no
  picture or text is sent anywhere. The only request is for the picture itself, from the same
  server the page got it from, without cookies.
- **Only post pictures.** Thumbnails, photos, memes, screenshots and link cards — never avatars,
  emoji or icons, and never anything outside a post.
- **Shorts, too.** A video's frames aren't pictures it can read, but YouTube keeps every Short's
  first frame as one, and a caption burned into a Short is nearly always on it. In the Shorts
  player that frame is read for the Short on screen and the next two, so a swipe usually lands
  on one already read. A Short skipped this way says *"word" in an image*. With **Blur until
  read** on, a Short stays covered and paused until its frame has been read.
- **Blur until read** (off by default): a post's picture stays blurred until it has been read, so
  you don't see the thing you're about to have hidden. Pictures are read nearest-the-screen first,
  about a second each, two at a time — so on a page full of thumbnails they clear one by one over
  a good few seconds, which is why it's off unless you turn it on. A post you click **Show** on is
  unblurred straight away.
- **How well it reads.** Screenshots of posts and headlines, and meme captions, read well.
  YouTube thumbnails, with their outlined, tilted lettering over faces, often don't — expect it
  to catch some of those, not most. English only. It reads *text*: a photo with no writing in it
  can't be matched.

Engine and model add about 4 MB to the extension. It runs two engines side by side while it has
work to do and shuts them down after a quiet minute.


The add-on id is `quietfeed@petru`. 

## Files

| Path | What it is |
| --- | --- |
| `manifest.json` | Extension manifest (MV2) |
| `src/common.js` | Config defaults, per-site selectors, keyword compiling |
| `src/content.js` | The hiding and silencing, and skipping in the Shorts player; injected into YouTube, Reddit and X |
| `src/hidden.css` | The placeholder, the rules that preserve the layout box, and the blur on unread pictures |
| `src/background.js` | Background page; answers the content scripts' requests to read a picture |
| `src/ocr.js` | Fetches a picture, reads it with Tesseract (two passes), keeps only confident words |
| `src/vendor/tesseract/` | Tesseract.js, its WebAssembly core and English model, unmodified (see its README) |
| `src/popup.*` | Toolbar popup: the word list |
| `src/options.*` | Settings page |
| `icons/` | `icon.svg` is the source; `icon-*.png` are generated for the manifest |
| `dev/make-icons.py` | Regenerates those PNGs from the SVG |
| `dev/` | Build script, self-tests, and developer notes in `dev/PACKAGING.md` |

## License

Mozilla Public License 2.0. See `LICENSE`.
