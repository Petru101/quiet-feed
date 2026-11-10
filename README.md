# Quiet Feed

**Quiet Feed: Hide Posts by Keyword** is an extension for Firefox and Chrome that allows you to block rage bait or whatever you want, 
on Reddit, Youtube and X, by adding words that you want blocked. Personally, I have over 400 at this point but I haven't included any 
in the extension itself. It can read words from images as well. 

Internet was affecting my mental health so I had to do something about it, or quit the internet. 

It's free, there is no server, no data collection.

<img width="340" height="321" alt="image" src="https://github.com/user-attachments/assets/3747d6fe-753b-499a-ad6e-a6f7df1191ce" />


Features:

- easy add and remove words
- toggle where it's active (posts/comments)
- preview mode to know what it would hide
- keep the space of hidden things or collapse it
- block Youtube shorts that have under a certain amount of comments
- you can lock modifications with a password
- you can export and import the list, enable automatic backup or use the browser sync option
- you can enable reading words from images
- everything runs on your computer

**Install:**
- [Firefox] https://addons.mozilla.org/en-US/firefox/addon/quiet-feed-filter/
- [Chrome] https://chromewebstore.google.com/detail/quiet-feed-hide-posts-by/gffelgkbghiehmlkepbpoanpfmffgacm

  
### How words match


What you type > What it matches

`cat` > "Cat", "cats", "Cat's" — but not "catapult"  

`mitchell & webb` > "Mitchell & Webb", "Mitchell and Webb", "Mitchell + Webb", "Mitchell - Webb"   

`ad` > "ad", "#ad", "ad-supported" — but not "@something-ad-nonsense" or "some_ad_guy"  

`something-ad-nonsense` > that whole handle, "@something-ad-nonsense"  

`/cat(s\|nip)/` > anything the regular expression matches  
.  

Text is read from the whole post container, so a match on the title, body, channel name,
subreddit or flair all hide the post.  

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
