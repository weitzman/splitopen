#!/usr/bin/env python3
"""Static server for local development that tells the browser not to cache,
and renders the song pages under s/ on the fly.

python3 -m http.server sends no Cache-Control header, so Chrome caches app.js
and styles.css heuristically and a plain reload can run stale code. This
serves the repo root the same way, with caching off.

    python3 scripts/serve.py [port]
"""
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SONG_PAGE = re.compile(r'^/s/([\w-]+)(/)?(?:[?#].*)?$')


class NoCacheHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # The song pages under s/ and 404.html (scripts/song-pages.py) are
        # derived and not in the repo; render them here so song addresses
        # work locally. GitHub Pages serves 404.html for any missing path.
        m = SONG_PAGE.match(self.path)
        if m:
            if not m.group(2):
                self.send_response(301)
                self.send_header('Location', '/s/' + m.group(1) + '/')
                self.end_headers()
                return
            import importlib
            pages = importlib.import_module('song-pages')
            page = pages.page(m.group(1))
            if page is None:
                self.send_page(pages.not_found(pages.site_url()), 404)
            else:
                self.send_page(page, 200)
            return
        super().do_GET()

    def send_page(self, text, status):
        body = text.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_head(self):
        # A copy cached before no-store took effect would be revalidated
        # and answered 304, keeping stale code alive; always send the file.
        del self.headers['If-Modified-Since']
        del self.headers['If-None-Match']
        return super().send_head()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    print(f'Serving on http://localhost:{port}/ (no-store)')
    ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
