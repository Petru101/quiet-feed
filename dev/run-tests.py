# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Run every self-test page in headless Chrome and report.

Run from the project root:  python3 dev/run-tests.py [-j JOBS] [filter ...]

A filter keeps the pages whose path contains it ("shorts", "ocr-check").
Exits non-zero if any check fails or a page never finishes.

Standard library only. It starts dev/serve.py on a free port, launches a
headless Chrome or Chromium with its own throwaway profile, opens each page
in a window of its own and reads the PASS/FAIL lines the page writes into
#out when it is done.

A window each, not a tab each: a tab behind another one is hidden, and the
Shorts and text-in-images code deliberately does nothing in a hidden tab, so
those pages would fail for a reason that isn't a bug.

The browser is the first of: $QF_CHROME (a command line), chromium /
google-chrome on PATH, or the Chrome or Chromium flatpak — through
host-spawn when this runs inside a distrobox.
"""

import argparse
import base64
import json
import os
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

PAGES = [
    '/dev/self-check.html',
    '/dev/shorts-check.html',
    '/dev/shorts-check.html?mobile=1',
    '/dev/shorts-check.html?late=1',
    '/dev/shorts-check.html?hidden=1',
    '/dev/shorts-check.html?hidden=1&slow=1',
    '/dev/shorts-check.html?ocr=1',
    '/dev/shorts-check.html?ocr=1&blur=1',
    '/dev/ui-check.html',
    '/dev/ui-check.html?collapsed=1',
    '/dev/ui-check.html?invalid=1',
    '/dev/ui-check.html?locked=1',
    '/dev/ui-check.html?options=1',
    '/dev/ocr-check.html',
    '/dev/ocr-check.html?denied=1',
    '/dev/ocr-check.html?off=1',
    '/dev/ocr-engine.html',
]

PAGE_TIMEOUT = 180          # seconds; ocr-engine.html loads the real engine
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# --- a WebSocket client, just enough for the DevTools protocol -------------

class DevTools:
    def __init__(self, url):
        u = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            'GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n'
            'Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n'
            'Sec-WebSocket-Version: 13\r\n\r\n' % (u.path, u.hostname, u.port, key)).encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError('DevTools closed the connection')
            head += chunk
        if b' 101 ' not in head.split(b'\r\n', 1)[0]:
            raise ConnectionError('DevTools refused the WebSocket: %r' % head[:80])
        self.next_id = 0

    def _recv_exact(self, n):
        data = b''
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError('DevTools closed the connection')
            data += chunk
        return data

    def _send_frame(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            head = struct.pack('!BB', 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            head = struct.pack('!BBH', 0x80 | opcode, 0x80 | 126, n)
        else:
            head = struct.pack('!BBQ', 0x80 | opcode, 0x80 | 127, n)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + body)

    def _recv_message(self):
        message = b''
        while True:
            b1, b2 = self._recv_exact(2)
            opcode = b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack('!H', self._recv_exact(2))[0]
            elif n == 127:
                n = struct.unpack('!Q', self._recv_exact(8))[0]
            payload = self._recv_exact(n)
            if opcode == 0x8:
                raise ConnectionError('DevTools closed the connection')
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode in (0x0, 0x1, 0x2):
                message += payload
                if b1 & 0x80:
                    return json.loads(message.decode('utf-8'))

    def call(self, method, **params):
        self.next_id += 1
        mine = self.next_id
        self._send_frame(0x1, json.dumps({'id': mine, 'method': method, 'params': params}).encode())
        while True:
            msg = self._recv_message()
            if msg.get('id') == mine:
                if 'error' in msg:
                    raise RuntimeError('%s: %s' % (method, msg['error'].get('message')))
                return msg.get('result', {})

    def evaluate(self, expression):
        result = self.call('Runtime.evaluate', expression=expression, returnByValue=True)
        return result.get('result', {}).get('value')

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# --- the browser ----------------------------------------------------------

def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def flatpak_command():
    """flatpak, directly or from inside a distrobox through host-spawn."""
    if shutil.which('flatpak'):
        return ['flatpak']
    if shutil.which('host-spawn'):
        return ['host-spawn', 'flatpak']
    return None


def find_browser():
    """(command, profile directory). A flatpak can only write inside its own
    ~/.var/app directory, so its profile goes there."""
    if os.environ.get('QF_CHROME'):
        return shlex.split(os.environ['QF_CHROME']), tempfile.mkdtemp(prefix='qf-tests-')
    for name in ('chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'):
        path = shutil.which(name)
        if path:
            return [path], tempfile.mkdtemp(prefix='qf-tests-')
    flatpak = flatpak_command()
    if flatpak:
        for app in ('com.google.Chrome', 'org.chromium.Chromium'):
            found = subprocess.run(flatpak + ['info', app], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL).returncode == 0
            if found:
                profile = os.path.expanduser('~/.var/app/%s/cache/quiet-feed-tests' % app)
                shutil.rmtree(profile, ignore_errors=True)
                os.makedirs(profile)
                return flatpak + ['run', app], profile
    sys.exit('No Chrome or Chromium found. Set QF_CHROME to the command that starts one.')


def wait_for(url, seconds):
    end = time.time() + seconds
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as res:
                return res.read()
        except OSError:
            time.sleep(0.25)
    return None


# --- running the pages ----------------------------------------------------

DONE = """(() => {
  const out = document.getElementById('out');
  const text = out ? out.textContent : '';
  return text && text !== 'running…' && !text.endsWith('…') ? text : null;
})()"""


def run_page(port, browser, lock, path):
    """(path, pass count, failed lines, error or None)."""
    url = 'http://127.0.0.1:%d%s' % (port, path)
    with lock:
        target = browser.call('Target.createTarget', url=url, newWindow=True)['targetId']
    page = None
    try:
        page = DevTools('ws://127.0.0.1:%d/devtools/page/%s' % (browser.port, target))
        end = time.time() + PAGE_TIMEOUT
        text = None
        while time.time() < end and text is None:
            time.sleep(0.5)
            try:
                text = page.evaluate(DONE)
            except RuntimeError:
                text = None          # mid-navigation; ask again
        if text is None:
            return path, 0, [], 'did not finish within %ds' % PAGE_TIMEOUT
        # A failure keeps the indented lines under it: ocr-engine.html says
        # there what was read and what was missing.
        passed = 0
        failed = []
        in_failure = False
        for line in text.split('\n'):
            if line.startswith('PASS'):
                passed += 1
                in_failure = False
            elif line.startswith('FAIL'):
                failed.append(line.strip())
                in_failure = True
            elif in_failure and line[:1].isspace() and line.strip():
                failed[-1] += '\n          ' + line.strip()
            else:
                in_failure = False
        if not passed and not failed:
            return path, 0, [], 'reported no checks: %r' % text[:200]
        return path, passed, failed, None
    except (OSError, ConnectionError, RuntimeError) as e:
        return path, 0, [], 'could not run: %s' % e
    finally:
        if page:
            page.close()
        with lock:
            try:
                browser.call('Target.closeTarget', targetId=target)
            except (OSError, ConnectionError, RuntimeError):
                pass


def main():
    parser = argparse.ArgumentParser(description='Run the Quiet Feed self-test pages headless.')
    parser.add_argument('-j', '--jobs', type=int, default=4,
                        help='pages run at once (default 4; 1 if timing checks flake)')
    parser.add_argument('filters', nargs='*', help='only pages whose path contains one of these')
    args = parser.parse_args()

    pages = [p for p in PAGES if not args.filters or any(f in p for f in args.filters)]
    if not pages:
        sys.exit('No page matches %s.' % ' '.join(args.filters))

    server_port = free_port()
    server = subprocess.Popen([sys.executable, 'dev/serve.py', str(server_port)], cwd=ROOT,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    command, profile = find_browser()
    devtools_port = free_port()
    chrome = subprocess.Popen(command + [
        '--headless=new', '--remote-debugging-port=%d' % devtools_port,
        '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
        '--window-size=1280,900', 'about:blank'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    browser = None
    failures = 0
    started = time.time()
    try:
        if not wait_for('http://127.0.0.1:%d/dev/serve.py' % server_port, 10):
            sys.exit('dev/serve.py did not start.')
        version = wait_for('http://127.0.0.1:%d/json/version' % devtools_port, 30)
        if not version:
            sys.exit('The browser did not start: %s' % ' '.join(command))
        info = json.loads(version)
        browser = DevTools(info['webSocketDebuggerUrl'])
        browser.port = devtools_port
        print('%s, %d page%s, %d at a time\n' % (info.get('Browser'), len(pages),
                                                 '' if len(pages) == 1 else 's', args.jobs))

        lock = threading.Lock()
        queue = list(pages)
        results = {}

        def worker():
            while True:
                with lock:
                    if not queue:
                        return
                    path = queue.pop(0)
                result = run_page(server_port, browser, lock, path)
                with lock:
                    results[path] = result
                    _, passed, failed, error = result
                    if error:
                        print('ERROR %-42s %s' % (path, error))
                    else:
                        print('%s  %-42s %d/%d' % ('FAIL' if failed else 'ok  ', path,
                                                   passed, passed + len(failed)))
                        for line in failed:
                            print('        ' + line)
                    sys.stdout.flush()

        threads = [threading.Thread(target=worker) for _ in range(max(1, args.jobs))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        total = sum(r[1] for r in results.values())
        failures = sum(len(r[2]) + (1 if r[3] else 0) for r in results.values())
        print('\n%d checks passed, %d failed or unfinished, in %ds' % (
            total, failures, time.time() - started))
    finally:
        if browser:
            try:
                browser.call('Browser.close')
            except (OSError, ConnectionError, RuntimeError):
                pass
            browser.close()
        for proc in (chrome, server):
            try:
                proc.terminate()
                proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                proc.kill()
        shutil.rmtree(profile, ignore_errors=True)

    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
