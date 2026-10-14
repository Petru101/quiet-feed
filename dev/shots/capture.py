# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Render the AMO store screenshots.

Run from anywhere:  python dev/shots/capture.py

Each shot is dev/shots/shot.html?shot=N. The feed, popup and settings page in
it run the real extension files against stubbed storage, so the placeholders,
outlines and counts pictured are what the extension actually draws. Only the
feed content is invented, and it copies no real site's branding.

Writes dev/shots/out/shot-N.png at 1280x800, the size AMO recommends.
"""

import functools
import http.server
import os
import shutil
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, 'out')
SHOTS = 4
SIZE = (1280, 800)

BROWSERS = [
    os.path.expandvars(r'%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe'),
    os.path.expandvars(r'%ProgramFiles%\Microsoft\Edge\Application\msedge.exe'),
    os.path.expandvars(r'%ProgramFiles%\Google\Chrome\Application\chrome.exe'),
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'),
]


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


def png_size(path):
    with open(path, 'rb') as f:
        return struct.unpack('>II', f.read(24)[16:24])


def main():
    browser = next((b for b in BROWSERS if os.path.exists(b)), None)
    if not browser:
        sys.exit('Needs Edge or Chrome for headless screenshots; found neither.')

    server = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Handler, directory=ROOT))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    os.makedirs(OUT, exist_ok=True)
    # A throwaway profile, so an Edge window you already have open doesn't
    # swallow the headless run.
    profile = tempfile.mkdtemp(prefix='qf-shots-')

    try:
        for n in range(1, SHOTS + 1):
            path = os.path.join(OUT, 'shot-%d.png' % n)
            if os.path.exists(path):
                os.remove(path)

            subprocess.run([
                browser,
                '--headless=new',
                '--disable-gpu',
                '--hide-scrollbars',
                '--no-first-run',
                '--user-data-dir=' + profile,
                '--force-device-scale-factor=1',
                '--window-size=%d,%d' % SIZE,
                '--virtual-time-budget=5000',    # let the extension scan before the shot
                '--screenshot=' + path,
                'http://127.0.0.1:%d/dev/shots/shot.html?shot=%d' % (port, n),
            ], timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            if not os.path.exists(path):
                sys.exit('shot %d was not written' % n)
            w, h = png_size(path)
            print('%s  %dx%d%s' % (os.path.relpath(path, ROOT), w, h,
                                   '' if (w, h) == SIZE else '   <-- expected %dx%d' % SIZE))
    finally:
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    main()
