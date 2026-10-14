# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Dev server for the self-check page. Sends no-store so edits to src/ are
picked up immediately instead of being served from the browser cache."""

import http.server
import socketserver
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


# Threaded: a browser holds idle pre-opened connections, and a single-threaded
# server blocks on one of them while every real request waits behind it.
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.daemon_threads = True

# A port can be given, so dev/run-tests.py can run beside a server already on 8731.
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8731

with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print('serving on http://127.0.0.1:%d/dev/self-check.html' % PORT)
    httpd.serve_forever()
