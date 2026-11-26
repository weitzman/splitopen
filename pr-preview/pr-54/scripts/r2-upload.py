#!/usr/bin/env python3
"""Upload song files to the R2 bucket through Cloudflare's API, without rclone.

    scripts/r2-upload.py [--levels] [song id]

upload-stems.sh runs this when rclone is not installed (a cloud session, say)
and passes its arguments through; it uploads the same files with the same
headers: segments with a year-long immutable cache, meta.json and
levels.json with an hour. --levels uploads only levels.json.

Unlike rclone sync it only adds and replaces files, never deletes, so a
re-encode that leaves fewer segments leaves the old extra ones in the bucket
(the player never asks for them; meta.json says how many there are).

Authentication is a Cloudflare API token with Workers R2 Storage Edit,
sent as a bearer token: CLOUDFLARE_API_TOKEN. In a cloud session whose
environment saves the token as a network secret for api.cloudflare.com, the
proxy adds it, and the variable may be unset. CLOUDFLARE_ACCOUNT_ID picks
the account; by default it is the token's only account. R2_BUCKET names the
bucket (default splitopen) and R2_PREFIX the folder in it (default songs).
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = 'https://api.cloudflare.com/client/v4'
IMMUTABLE = 'public, max-age=31536000, immutable'
HOUR = 'public, max-age=3600'


def request(method, url, data=None, headers=None):
    h = {'Authorization': 'Bearer ' + os.environ.get('CLOUDFLARE_API_TOKEN', 'proxy-injected'),
         'User-Agent': 'splitopen-r2-upload'}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429:
                body = e.read().decode('utf-8', 'replace')
                sys.exit(f'{method} {url.split("?")[0]}: {e.code} {body[:300]}')
            err = e
        except (urllib.error.URLError, OSError) as e:
            err = e
        time.sleep(2 ** attempt)
    sys.exit(f'{method} {url.split("?")[0]}: {err}')


def account_id():
    if os.environ.get('CLOUDFLARE_ACCOUNT_ID'):
        return os.environ['CLOUDFLARE_ACCOUNT_ID']
    accounts = request('GET', API + '/accounts')['result']
    if len(accounts) != 1:
        sys.exit(f'the token sees {len(accounts)} accounts; set CLOUDFLARE_ACCOUNT_ID')
    return accounts[0]['id']


def headers_for(name):
    if name.endswith('.opus'):
        return {'Content-Type': 'audio/ogg', 'Cache-Control': IMMUTABLE}
    if name.endswith('.json'):
        return {'Content-Type': 'application/json', 'Cache-Control': HOUR}
    return None  # anything else (.DS_Store and the like) stays local


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--levels', action='store_true', help='upload only levels.json')
    ap.add_argument('song', nargs='?', help='one song id (default: every song in audio/songs/)')
    args = ap.parse_args()

    base = os.path.join(ROOT, 'audio', 'songs')
    songs = [args.song] if args.song else sorted(os.listdir(base))
    files = []
    for song in songs:
        d = os.path.join(base, song)
        if not os.path.isdir(d):
            sys.exit(f'no song at audio/songs/{song}')
        for dirpath, _, names in os.walk(d):
            for name in names:
                if args.levels and name != 'levels.json':
                    continue
                if headers_for(name):
                    path = os.path.join(dirpath, name)
                    files.append((path, os.path.relpath(path, base).replace(os.sep, '/')))
    if not files:
        sys.exit('nothing to upload' + (' (run scripts/stem-levels.py first)' if args.levels else ''))

    bucket = os.environ.get('R2_BUCKET', 'splitopen')
    prefix = os.environ.get('R2_PREFIX', 'songs').strip('/')
    url = f'{API}/accounts/{account_id()}/r2/buckets/{bucket}/objects/'

    def put(item):
        path, key = item
        with open(path, 'rb') as f:
            body = f.read()
        # The API wants the key's slashes literal, everything else escaped.
        request('PUT', url + urllib.parse.quote(f'{prefix}/{key}', safe='/'), body, headers_for(key))
        return key

    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for key in pool.map(put, files):
            done += 1
            print(f'\r{done}/{len(files)} {key}', end='', flush=True)
    print(f'\nuploaded {len(files)} files to {bucket}/{prefix}')


if __name__ == '__main__':
    main()
