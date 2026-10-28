# Introduction

Our favorite songs, [Split Open](https://www.splitopen.org) so we can learn and appreciate. Solo the keys during a particularly pretty passage, or mute the guitar so you can play that part. My dream for this project is for bands to take my code (its freely available) and offer this player as a service to their fans. I'm available to help. My email is weitzman@tejasa.com.

# Technology

Split Open is a stem mixer for live recordings: each band member on a separate
channel with mute, solo, and a fader, playing in sync.

- `index.html`, `app.js`, `styles.css`, `songs.yaml`, `bands.yaml` — the player
  (static HTML + Web Audio API, no build step), served from the repo root.
  The data files are YAML.

- A song directory (the song's `dir` in `songs.yaml`, under `songs/<id>/` in
  the bucket, see Hosting) holds the song's stems (any of guitar, bass, keys,
  drums, vocals, horns, flute), each a directory of 10-second Opus segments
  (128 kbps, Ogg container), plus a `meta.json` with the song's length and
  the segment grid. The player decodes a few segments ahead of the playhead
  and keeps decoded audio within a memory budget, so a song starts in under
  a second.
- A song in `songs.yaml` names its band, whose lineup comes from `bands.yaml`
  (`who` and `inst` per stem: guitar, bass, keys, drums, vocals, horns,
  flute). 
- `scripts/add-song.sh` — download a FLAC from archive.org, separate it with
  BS-Roformer-SW (`audio-separator`), encode the stems, upload them, register
  the song in `songs.yaml`
- `scripts/upload-stems.sh` — sync `audio/songs/` (or one song) to the bucket
- `scripts/segment-stems.py` — encode a song's stems (any audio ffmpeg reads) as
  segments into a song directory under `audio/songs/<id>/`, the gitignored
  local copy that `upload-stems.sh` syncs; `scripts/seam-test.py` decodes a stem's
  segments the way the player plays them and checks the joins are seamless
- `scripts/split-other.py` — divide BS-Roformer-SW's `other` stem, which
  holds every wind instrument and (for some bands) the organ, between
  `horns`, `keys` and `flute`, guided by the stems of ZFTurbo's 53-stem MVSep
  Mega model (see the script for how to run it)
- `schemas/` — JSON Schemas (draft 2020-12) for the YAML files, published
  with the site:
  [songs.schema.json](https://www.splitopen.org/schemas/songs.schema.json),
  [bands.schema.json](https://www.splitopen.org/schemas/bands.schema.json) and
  [guide.schema.json](https://www.splitopen.org/schemas/guide.schema.json),
  sharing `common.schema.json` (the stem list and the common string kinds).
  The check scripts apply the same schemas through `scripts/schema.py`.
- `scripts/check-songs.py` — checks `songs.yaml` and `bands.yaml` strictly,
  as the player reads them: their schemas (every field present and of the
  right kind, no unknown fields), then the band in `bands.yaml`, the date a
  real date, `meta.json` and every segment of the song's stems at the song's
  `dir` URL (a HEAD request each). A pull request that breaks either fails
  its "Check data" workflow, and a merged one fails the deploy.
- `scripts/song-pages.py`, `scripts/song-cards.py` — the link previews; see
  Unfurling below.

A song's address is `s/<id>/`, and the hash holds the mix and the moment, so
a link can reproduce both:

    s/1998-07-26-funky-bitch/#solo=keys&mute=vocals&g=guitar:0.8,bass:1.2&t=312

- `solo`, `mute` — comma-separated stem ids: `guitar`, `bass`, `keys`, `drums`, `vocals`, `horns`, `flute`
- `g` — fader gains as `stem:value` pairs, 0 to 1.5 (1 is unity)
- `t` — position in seconds; the player seeks there but waits for Play

The player keeps the address current as you mix (a mix change replaces the
history entry, a song change adds one), and the Share button (or `L`) copies
it with the current position.

## Hosting

The site is static on GitHub Pages; the stems are not in the repo. They
live in a Cloudflare R2 bucket (`splitopen`, under `songs/<id>/`) served
at `https://stems.splitopen.org` (each song's `dir`), the bucket's custom
domain, which puts the files behind Cloudflare's cache; the bucket's r2.dev
URL is rate-limited and is not used. The bucket has a CORS policy that
allows any origin to GET and exposes `Content-Length` (the loading bar
reads it).
Uploads go through an rclone remote named `r2` with an R2 API token that
can read and write the bucket:

    rclone config create r2 s3 provider=Cloudflare \
      access_key_id=… secret_access_key=… \
      endpoint=https://<account id>.r2.cloudflarestorage.com no_check_bucket=true

`scripts/upload-stems.sh` syncs every song (or one by id) with a year-long
immutable cache header on segments and an hour on `meta.json`.

## Guides

Guides is an experimental feature which is not yet shown by default. Append `?guide=1` to the query string to show the **Guides** row under the song title. A guide is a listening tour of a song: an ordered list of tips, each a
passage, a mix, and a description..

To write one, press **+ New guide** under the song title, play the song, set mute/solo, and press `N` (or
**Tip: Start**) where a passage worth a tip begins. The tip takes that
moment and the current mix, and runs to the next tip unless given an end.
The list shows one line per tip with edit, play and delete; edit opens that
tip alone, with its start, optional end and description.

To offer a guide to the library, press **Contribute** on a guide you wrote
(or one that reached you by link). A sheet asks for the title, your name,
an optional link for it and the notes' language, shows the text as it will
be submitted, and **Email it** opens the mail app with the guide addressed
to contribute@splitopen.org, along with the song, the file it would become
(`guides/<song id>/<slug>.yaml`) and its link; the maintainer adds the file.

Run locally with `python3 scripts/serve.py` (a static server that turns
caching off, so a reload always gets the current files) and open
`http://localhost:8765/`. Any static server from the repo root works too.
The scripts need PyYAML and jsonschema 4.18 or later (`python3 -m pip install pyyaml 'jsonschema>=4.18'`);
the workflows install them when the runner lacks them.

## Unfurling

The deploy workflows write song-specific unfurl images, plus a `404.html` that boots the player for a path with no file, with
`scripts/song-pages.py`, and render the cards with `scripts/song-cards.py`
(headless Chrome, from a template of the player). `s/` and `404.html` are
gitignored, and `scripts/serve.py` renders the pages on the fly locally. The
site's own card, `social.png`, is committed: rerun
`python3 scripts/song-cards.py --site --only` after changing the template.

## License

The code and documentation in this repository are released under the
[MIT License](LICENSE).
