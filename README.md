# Introdution

Our favorite songs, [Split Open](https://weitzman.github.io/splitopen) so we can learn and appreciate. Solo the keys during a particularly pretty passage, or mute the guitar so you can play that part. My dream for this project is for bands to take my code (its freely available) and offer this player as a service to their fans. I'm available to help. My email is weitzman@tejasa.com.


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
- `schemas/` — JSON Schemas (draft 2020-12) for the YAML files:
  `songs.schema.json`, `bands.schema.json` and `guide.schema.json`, sharing
  `common.schema.json` (the stem list and the common string kinds). They
  are published with the site at `https://weitzman.github.io/splitopen/schemas/`,
  and each YAML file's first line is a `# yaml-language-server: $schema=`
  comment pointing at its schema, so an editor with a YAML language server
  (VS Code's YAML extension, for one) completes the fields and marks
  mistakes as you type. The check scripts apply the same schemas through
  `scripts/schema.py`, so the rules live in one place.
- `scripts/check-songs.py` — checks `songs.yaml` and `bands.yaml` strictly,
  as the player reads them: their schemas (every field present and of the
  right kind, no unknown fields), then the band in `bands.yaml`, the date a
  real date, `meta.json` and every segment of the song's stems at the song's
  `dir` URL (a HEAD request each). A pull request that breaks either fails
  its "Check data" workflow, and a merged one fails the deploy.
- `scripts/song-pages.py`, `scripts/song-cards.py` — the link previews; see
  Unfurling below.

A song's address is `s/<id>/`, and the hash holds the mix and the moment, so
a link can reproduce both; the pairs are `&`-separated `key=value`, all
optional:

    s/1998-07-26-funky-bitch/#solo=keys&mute=vocals&g=guitar:0.8,bass:1.2&t=312

- `solo`, `mute` — comma-separated stem ids: `guitar`, `bass`, `keys`, `drums`, `vocals`, `horns`, `flute`
- `g` — fader gains as `stem:value` pairs, 0 to 1.5 (1 is unity)
- `t` — position in seconds; the player seeks there but waits for Play

The player keeps the address current as you mix (a mix change replaces the
history entry, a song change adds one), and the Share button (or `L`) copies
it with the current position.

## Unfurling

Unfurlers never see the hash, which is why the song is in the path: the page
at `s/<id>/` is `index.html` with the song's own title, description and card
in its Open Graph and Twitter tags (the block `index.html` marks with
`link preview` comments) and a `<base>` at the site root, so the address bar
is a link that unfurls as the song. The deploy workflows write the pages,
plus a `404.html` that boots the player for a path with no file, with
`scripts/song-pages.py`, and render the cards with `scripts/song-cards.py`
(headless Chrome, from a template of the player); `s/` and `404.html` are
gitignored, and `scripts/serve.py` renders the pages on the fly locally. The
site's own card, `social.png`, is committed: rerun
`python3 scripts/song-cards.py --site --only` after changing the template.

## Hosting

The site is static on GitHub Pages; the stems are not in the repo. They
live in a Cloudflare R2 bucket (`splitopen`, under `songs/<id>/`) served
at `https://stems.splitopen.fm` (each song's `dir`), the bucket's custom
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

Guides is an experimental feature which is not yet shown by default. The **Guides** row under the song title is shown only with `?guide=1` in the query string (before the hash).

A guide is a listening tour of a song: an ordered list of tips, each a
passage, a mix, and a note. The mix holds for the passage and the band plays
in full between tips; when the playhead reaches a tip its note is shown.

To write one, press **+ New guide** under the song title, play the song, set mute/solo, and press `N` (or
**Tip: Start**) where a passage worth a tip begins. The tip takes that
moment and the current mix, and runs to the next tip unless given an end.
The list shows one line per tip with edit, play and delete; edit opens that
tip alone, with its start, optional end and description. Start and end are set from the playhead: scrub or
play to the moment, then press Set. Tapping the mix label opens a sheet with
Mute and Solo per player, heard as you choose. Tips can be dragged into another order
by their handle. The list is always saved: the draft is kept in the link as it
changes, so **Share** hands it out and a reload brings it back. The title, author and language are not asked for while writing; they
belong to the step of offering a guide to the library.

Guides are written as YAML:

    title: Mike's entrance
    lang: en
    by: Foo Bar
    url: https://example.com/foo
    tips:
      - at: 0:00
        to: 0:32
        solo: [drums]
        note: Fish sets up the groove alone.
      - at: 0:32
        to: 1:05
        solo: [drums, bass]
        pause: true
        note: Mike enters. Notice he plays behind the beat.
      - at: 1:05
        to: 1:20
        mute: vocals
        note: The band without the singing.
      - at: 1:05
        to: 1:20
        solo: keys
        gain: {bass: 0.8}
        note: The same passage, Page alone.

- The top-level keys are `title`, `lang` (the notes' language code, e.g.
  `en` or `fr`), `by` (the author's name, shown after the guide's title),
  `url` (a link for the author's name) and `tips`.
- A tip has `at` (`m:ss`, with tenths if wanted: `1:05.5`), then any of `to`
  (where the tip ends; without it, at the next tip), `solo` and `mute` (a
  player or a list of players: `guitar`, `bass`, `keys`, `drums`, `vocals`,
  `horns`, `flute`),
  `gain` (a map of player to fader level, 0 to 1.5), `pause` and `note`. A
  later tip may start before the one before it ends, which is how a passage
  is replayed.
- `pause: true` stops the music at the tip until the listener presses Continue.
- A note that holds a colon followed by a space, or a `#`, needs quotes, as
  YAML has it: `note: "Trey: listen for the bend"`.

Guides kept in the repo live at `guides/<song id>/<slug>.yaml` in the form
above, listed by slug under the song id in `guides.json`; they appear as
pills under the song and open with `guide=<slug>`. `guides.json` is derived
from the files: the deploy workflows regenerate it, and
`python3 scripts/guides-index.py` checks every guide against
`schemas/guide.schema.json` and rewrites it locally.

To offer a guide to the library, press **Contribute** on a guide you wrote
(or one that reached you by link). A sheet asks for the title, your name,
an optional link for it and the notes' language, shows the text as it will
be submitted, and **Email it** opens the mail app with the guide addressed
to splitopen@cyrve.com, along with the song, the file it would become
(`guides/<song id>/<slug>.yaml`) and its link; the maintainer adds the file.
**Copy text** is for sending the guide some other way. A guide that is not yet in
the library has an **Edit** button, which goes back to writing it.

A guide travels in the link: `#songid&guide=<slug>` for one in the repo, or
`guide=z…`, the deflated text, for one written in the player or by hand.

Run locally with `python3 scripts/serve.py` (a static server that turns
caching off, so a reload always gets the current files) and open
`http://localhost:8765/`. Any static server from the repo root works too.
The scripts need PyYAML and jsonschema 4.18 or later (`python3 -m pip install pyyaml 'jsonschema>=4.18'`);
the workflows install them when the runner lacks them.

The site is served by GitHub Pages from the `gh-pages` branch, which a
workflow refreshes from `main` on every push. Each pull request gets a
preview at `https://weitzman.github.io/splitopen/pr-preview/pr-<number>/`,
linked from a comment on the PR and removed when it closes. Links to the
old `/web/` path redirect to the root.

## License

The code and documentation in this repository are released under the
[MIT License](LICENSE).
