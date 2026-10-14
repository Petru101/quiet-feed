# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Build quiet-feed.xpi for AMO, and check it before writing it.

Run from the project root:  python dev/package.py

AMO wants a ZIP of the extension's *files*, with manifest.json at the root of
the archive. Zipping the containing folder instead produces a package whose
manifest is one level down, which AMO rejects outright — and because it then
can't read the manifest, it also reports unrelated-looking warnings about
missing gecko.id. One mistake, three confusing errors.

It also keeps dev/ out. The test harnesses use inline <script>, which is fine
for a local page served over http but trips AMO's content-security-policy
warning if it ever ships.
"""

import json
import os
import re
import sys
import zipfile

OUT = 'quiet-feed.xpi'
SHIP = ['manifest.json', 'LICENSE', 'src', 'icons']

# --- Chromium ------------------------------------------------------------
# Chrome, Edge and Opera are one target: all three are Chromium and take the
# same MV3 package. Nothing under src/ is edited to build it. The Firefox
# package comes out of this script byte for byte as it did before — the
# Chromium one swaps in a second manifest, adds the files Firefox never
# loads, and hides the one switch MV3 can't honour.
CHROME_MANIFEST = 'manifest.chrome.json'
CHROME_OUT = 'quiet-feed-chrome.zip'

# The other direction, and easy to miss: collect() walks src/ recursively, so
# without this the Chromium-only files would ride along inside the .xpi.
# They would never run there, but AMO reviews every file that ships, and an
# importScripts call Firefox never executes is a question nobody wants to
# field. Keeping them out is also what makes "the Firefox package is
# unchanged" true rather than nearly true.
#
# The last three are reading text in images: a service worker has no DOM and
# cannot spawn the dedicated Worker Tesseract needs, so the engine runs in an
# offscreen document and the worker passes reads across to it.
CHROME_ONLY = ('src/compat.js', 'src/sw.js',
               'src/ocr-bridge.js', 'src/offscreen.html', 'src/offscreen.js')

# Backing up automatically needs URL.createObjectURL, which a service worker
# doesn't have. It is off by default and manifest.chrome.json doesn't grant
# the permission, so the code path is already unreachable. This only stops
# the settings page offering a switch that would silently do nothing.
CHROME_HIDE = """    <style>
      /* Chromium build: Firefox-only feature. See src/sw.js. */
      label.opt:has(#autoBackup),
      #backup-status,
      #saved-backup { display: none !important; }
    </style>
"""

# Chrome 153, Edge 153 and Opera 136 all turned out to expose their own
# promise-based `browser`, so the shim is a no-op on every browser this has run
# in. The pages load it anyway, for two reasons: other Chromium forks and older
# versions may not, and having it in the content scripts but not the pages is
# how you get a settings page that breaks on exactly the browsers where the
# filtering still works — a miserable bug to be handed.
CHROME_PAGES = ('src/options.html', 'src/popup.html')
SHIM_TAG = '<script src="compat.js"></script>'
COMMON_TAG = '<script src="common.js"></script>'

# The settings page names Firefox where it says who will ask for the image
# permission. Chrome, Edge and Opera all take this package, so the Chromium
# copy says "your browser". Rewritten on the way into the zip, like the shim.
CHROME_TEXT = {
    'src/options.html': [
        ('Firefox will ask to let', 'Your browser will ask to let'),
        ("an image server that Firefox hasn't allowed yet.",
         "an image server that your browser hasn't allowed yet."),
    ],
    'src/options.js': [
        ('"Couldn\'t ask Firefox for the permission."',
         '"Couldn\'t ask the browser for the permission."'),
    ],
}


def chromify(path, text):
    """The Chromium copy of an extension file. The file on disk is untouched."""
    out = text
    if path in CHROME_PAGES:
        out = out.replace(COMMON_TAG, SHIM_TAG + '\n  ' + COMMON_TAG, 1)
    if path == 'src/options.html':
        out = out.replace('</head>', CHROME_HIDE + '  </head>', 1)
    for old, new in CHROME_TEXT.get(path, []):
        out = out.replace(old, new)
    return out


def chromified(path):
    """Whether chromify() changes this file on its way into the zip."""
    return path in CHROME_PAGES or path in CHROME_TEXT


def collect():
    """Every file under the shipped entries, recursively: src/vendor/ lives a
    level down, and a flat listing once left the OCR engine out of the xpi."""
    files = []
    for entry in SHIP:
        if os.path.isfile(entry):
            files.append(entry)
            continue
        for dirpath, dirnames, filenames in os.walk(entry):
            dirnames.sort()
            for name in sorted(filenames):
                files.append(os.path.join(dirpath, name).replace(os.sep, '/'))
    return files


# Loaded by URL at run time rather than named in the manifest, so the
# manifest check below can't see them. src/ocr.js builds these paths.
OCR_ASSETS = [
    'src/vendor/tesseract/tesseract.min.js',
    'src/vendor/tesseract/worker.min.js',
    'src/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
    'src/vendor/tesseract/eng.traineddata.gz',
]


def check(files):
    """Returns a list of problems; empty means good to upload."""
    problems = []

    if 'manifest.json' not in files:
        problems.append('manifest.json is missing from the package root')
        return problems

    manifest = json.load(open('manifest.json', encoding='utf-8'))

    # every path the manifest points at must actually be in the package
    referenced = []
    for size, path in (manifest.get('icons') or {}).items():
        referenced.append(path)
    action = manifest.get('browser_action') or {}
    icon = action.get('default_icon')
    if isinstance(icon, dict):
        referenced.extend(icon.values())
    elif icon:
        referenced.append(icon)
    if action.get('default_popup'):
        referenced.append(action['default_popup'])
    if (manifest.get('options_ui') or {}).get('page'):
        referenced.append(manifest['options_ui']['page'])
    for script in manifest.get('content_scripts') or []:
        referenced.extend(script.get('js') or [])
        referenced.extend(script.get('css') or [])
    referenced.extend((manifest.get('background') or {}).get('scripts') or [])

    for path in referenced:
        if path not in files:
            problems.append('manifest points at %s, which is not in the package' % path)

    # AMO blocks inline scripts under the default CSP
    for path in files:
        if path.endswith('.html'):
            html = open(path, encoding='utf-8').read()
            if re.search(r'<script(?![^>]*\bsrc=)[^>]*>', html):
                problems.append('%s contains an inline <script>' % path)

    # Reading text in images: the engine is loaded by URL, and its WebAssembly
    # won't compile under the default policy.
    for path in OCR_ASSETS:
        if path not in files:
            problems.append('%s is missing; reading text in images would fail' % path)
    if "'wasm-unsafe-eval'" not in (manifest.get('content_security_policy') or ''):
        problems.append("content_security_policy lacks 'wasm-unsafe-eval'; the OCR engine can't start")
    for path in files:
        if path.endswith('.map'):
            problems.append('%s is a source map and should not ship' % path)

    gecko = (manifest.get('browser_specific_settings') or {}).get('gecko') or {}

    if not gecko.get('id'):
        problems.append('browser_specific_settings.gecko.id is missing')

    # AMO requires an explicit data-collection declaration on new submissions.
    consent = gecko.get('data_collection_permissions')
    if not consent:
        problems.append('browser_specific_settings.gecko.data_collection_permissions is missing '
                        '(AMO requires it; use {"required": ["none"]} if nothing is collected)')
    else:
        required = consent.get('required') or []
        if not required:
            problems.append('data_collection_permissions.required is empty')
        elif 'none' in required and len(required) > 1:
            problems.append('data_collection_permissions.required lists "none" alongside other '
                            'values; "none" has to stand alone')

    if 'LICENSE' not in files:
        problems.append('LICENSE is missing (MPL 2.0 is declared on the AMO listing)')

    for path in files:
        if path.startswith('dev/'):
            problems.append('%s is a development file and should not ship' % path)

    return problems


def collect_firefox():
    """Everything collect() finds, minus the files only Chromium loads."""
    return [p for p in collect() if p not in CHROME_ONLY]


def collect_chrome():
    """Every file, minus Firefox's own manifest.

    manifest.chrome.json is added separately, under the name manifest.json,
    because that is the only name a browser looks for."""
    return [p for p in collect() if p != 'manifest.json']


def check_chrome(files):
    """Returns a list of problems; empty means the package will load."""
    problems = []

    if not os.path.exists(CHROME_MANIFEST):
        problems.append('%s is missing' % CHROME_MANIFEST)
        return problems

    manifest = json.load(open(CHROME_MANIFEST, encoding='utf-8'))

    if manifest.get('manifest_version') != 3:
        problems.append('%s is not manifest_version 3, and Chrome no longer loads MV2'
                        % CHROME_MANIFEST)

    # The Chrome Web Store rejects the upload over this. Firefox takes a longer
    # description, so manifest.json is no guide.
    description = manifest.get('description') or ''
    if len(description) > 132:
        problems.append('%s description is %d characters; the Chrome Web Store allows 132'
                        % (CHROME_MANIFEST, len(description)))

    # Same idea as the Firefox check: every path named must actually be there.
    referenced = list((manifest.get('icons') or {}).values())
    action = manifest.get('action') or {}
    icon = action.get('default_icon')
    if isinstance(icon, dict):
        referenced.extend(icon.values())
    elif icon:
        referenced.append(icon)
    if action.get('default_popup'):
        referenced.append(action['default_popup'])
    if (manifest.get('options_ui') or {}).get('page'):
        referenced.append(manifest['options_ui']['page'])
    for script in manifest.get('content_scripts') or []:
        referenced.extend(script.get('js') or [])
        referenced.extend(script.get('css') or [])
    worker = (manifest.get('background') or {}).get('service_worker')
    if worker:
        referenced.append(worker)

    for path in referenced:
        if path not in files:
            problems.append('%s points at %s, which is not in the package'
                            % (CHROME_MANIFEST, path))

    # Chromium has no `browser`, so the shim has to run before anything reads
    # it. Ordering here is the whole reason src/ needed no edits.
    for script in manifest.get('content_scripts') or []:
        js = script.get('js') or []
        if 'src/compat.js' not in js:
            problems.append('content_scripts omit src/compat.js; browser would be undefined')
        elif js[0] != 'src/compat.js':
            problems.append('src/compat.js has to come first in content_scripts.js')

    # Two manifests drifting apart is silent and maddening to debug.
    firefox = json.load(open('manifest.json', encoding='utf-8'))
    if firefox.get('version') != manifest.get('version'):
        problems.append('version mismatch: manifest.json says %s, %s says %s'
                        % (firefox.get('version'), CHROME_MANIFEST, manifest.get('version')))

    # Granting this would put a working switch in front of a code path that
    # cannot run in a service worker.
    granted = set(manifest.get('permissions') or [])
    granted |= set(manifest.get('optional_permissions') or [])
    if 'downloads' in granted:
        problems.append('downloads is granted, but writeBackup needs URL.createObjectURL, '
                        'which a service worker does not have')

    # Reading text in images: the engine runs in an offscreen document, is
    # loaded by URL, and its WebAssembly won't compile under the default
    # policy. The image hosts are asked for at run time, and Chromium only
    # grants what the manifest lists as optional — a host missing here is a
    # permission request that fails for everyone.
    if 'offscreen' not in granted:
        problems.append('offscreen is not granted; the OCR engine has nowhere to run')
    for path in OCR_ASSETS:
        if path not in files:
            problems.append('%s is missing; reading text in images would fail' % path)
    csp = (manifest.get('content_security_policy') or {}).get('extension_pages') or ''
    if "'wasm-unsafe-eval'" not in csp:
        problems.append("content_security_policy.extension_pages lacks 'wasm-unsafe-eval'; "
                        "the OCR engine can't start")
    image_hosts = [o for o in firefox.get('optional_permissions') or [] if '://' in o]
    if sorted(manifest.get('optional_host_permissions') or []) != sorted(image_hosts):
        problems.append('optional_host_permissions in %s differ from the image hosts in '
                        "manifest.json's optional_permissions" % CHROME_MANIFEST)

    # chromify() edits these by string match, so a renamed tag has to fail here
    # rather than ship a settings page with no scripts and no explanation.
    for page in CHROME_PAGES:
        if page not in files:
            problems.append('%s is missing from the package' % page)
            continue
        html = open(page, encoding='utf-8').read()
        if COMMON_TAG not in html:
            problems.append('%s no longer contains %s, so the Chromium shim '
                            'cannot be inserted before it' % (page, COMMON_TAG))
        if page == 'src/options.html' and '</head>' not in html:
            problems.append('%s has no </head> to hide the Firefox-only rows in' % page)

    # The same goes for the wording swapped out of the settings page.
    for path, swaps in CHROME_TEXT.items():
        text = open(path, encoding='utf-8').read()
        for old, new in swaps:
            if old not in text:
                problems.append('%s no longer contains %s, so the Chromium wording '
                                'cannot replace it' % (path, old))

    for path in files:
        if path.endswith('.html'):
            html = open(path, encoding='utf-8').read()
            if re.search(r'<script(?![^>]*\bsrc=)[^>]*>', html):
                problems.append('%s contains an inline <script>' % path)
            # offscreen.html is opened by URL, so the manifest check can't see
            # what it loads.
            base = os.path.dirname(path)
            for src in re.findall(r'<script[^>]*\bsrc="([^"]+)"', html):
                if os.path.normpath(os.path.join(base, src)).replace(os.sep, '/') not in files:
                    problems.append('%s loads %s, which is not in the package' % (path, src))
        if path.endswith('.map'):
            problems.append('%s is a source map and should not ship' % path)

    return problems


def build_chrome():
    files = collect_chrome()
    problems = check_chrome(files)

    if problems:
        print('Not packaging for Chromium. Fix these first:\n')
        for p in problems:
            print('  - %s' % p)
        sys.exit(1)

    if os.path.exists(CHROME_OUT):
        os.remove(CHROME_OUT)
    with zipfile.ZipFile(CHROME_OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(CHROME_MANIFEST, 'manifest.json')    # MV3, at the archive root
        for path in files:
            if chromified(path):
                # Rewritten on the way in; the file on disk is left alone.
                z.writestr(path, chromify(path, open(path, encoding='utf-8').read()))
            else:
                z.write(path, path)

    manifest = json.load(open(CHROME_MANIFEST, encoding='utf-8'))
    print('%s  %s v%s' % (CHROME_OUT, manifest['name'], manifest['version']))
    print('%d files, %.1f KB\n' % (len(files) + 1, os.path.getsize(CHROME_OUT) / 1024.0))
    print('  manifest.json  (from %s)' % CHROME_MANIFEST)
    for path in files:
        note = ''
        if path == 'src/options.html':
            note = '  (shim added, Firefox-only rows hidden, wording)'
        elif path in CHROME_PAGES:
            note = '  (shim added)'
        elif chromified(path):
            note = '  (wording)'
        print('  %s%s' % (path, note))
    print('\nLoad it in Chrome, Edge or Opera with Developer mode > Load unpacked,')
    print('or drag the zip onto chrome://extensions.')


def build_firefox():
    files = collect_firefox()
    problems = check(files)

    if problems:
        print('Not packaging. Fix these first:\n')
        for p in problems:
            print('  - %s' % p)
        sys.exit(1)

    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for path in files:
            z.write(path, path)          # forward slashes, manifest at the root

    manifest = json.load(open('manifest.json', encoding='utf-8'))
    print('%s  %s v%s' % (OUT, manifest['name'], manifest['version']))
    print('%d files, %.1f KB\n' % (len(files), os.path.getsize(OUT) / 1024.0))
    for path in files:
        print('  %s' % path)
    print('\nUpload this file as-is. Do not re-zip it, and do not zip the folder.')


def main():
    """No argument builds the Firefox package, exactly as it always did."""
    target = (sys.argv[1] if len(sys.argv) > 1 else 'firefox').lower()

    if target in ('firefox', 'ff', 'xpi'):
        build_firefox()
    elif target in ('chrome', 'chromium', 'edge', 'opera'):
        build_chrome()
    elif target == 'all':
        build_firefox()
        print()
        build_chrome()
    else:
        print('Unknown target %r. Use: firefox (the default), chrome, or all.' % target)
        sys.exit(2)


if __name__ == '__main__':
    main()
