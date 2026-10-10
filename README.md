# Split Open

Our favorite songs, [Split Open](https://weitzman.github.io/splitopen) so we can learn and appreciate.

A stem mixer for live recordings: each band member on a separate
channel with mute, solo, and a fader, playing in sync.

- `index.html`, `app.js`, `styles.css`, `songs.yaml`, `bands.yaml` — the player
  (static HTML + Web Audio API, no build step), served from the repo root.
  The data files are YAML, read in the browser by `vendor/js-yaml.min.js`
  (js-yaml 4.1.0) with its core schema, and by the scripts with PyYAML
  through `scripts/yaml12.py`, which gives PyYAML the same YAML 1.2 reading:
  `0:30` and `1998-07-26` are strings, `yes` is a word, only `true` and
  `false` are booleans.
- `audio/songs/<id>/` — five Opus stems per song (128 kbps, Ogg container): guitar, bass, keys, drums, vocals
- A song in `songs.yaml` names its band, whose lineup comes from `bands.yaml`
  (`who` and `inst` per stem: guitar, bass, keys, drums, vocals). A song can
  override any of those for the night, since lineups change: a `channels`
  map on the song with the stems to change, e.g.
  `channels: {keys: {who: Page & Medeski}, guitar: {inst: Guitars}}`.
  Its `source` is the archive.org item page the recording came from. A
  song with `hidden: true` stays out of the picker but still plays from a
  direct link.
- `scripts/add-song.sh` — download a FLAC from archive.org, separate it with
  BS-Roformer-SW (`audio-separator`), encode the stems, register the song in
  `songs.yaml`
- `scripts/check-songs.py` — checks `songs.yaml` and `bands.yaml` strictly,
  as the player reads them: every field present and of the right kind, no
  unknown fields, the band in `bands.yaml`, the date a date, the five stem
  files in `dir`. A pull request that breaks either fails its "Check data"
  workflow, and a merged one fails the deploy.
- `scripts/social-card.html` — source for `social.png`, the link-preview image.
  Regenerate after editing it with headless Chrome:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --virtual-time-budget=8000 --window-size=1200,630 --screenshot=social.png file://$PWD/scripts/social-card.html`

The URL hash holds the song and, optionally, the mix and the moment, so a
link can reproduce both. The song id comes first; the rest are `&`-separated
`key=value` pairs, all optional:

    #1998-07-26-funky-bitch&solo=keys&mute=vocals&g=guitar:0.8,bass:1.2&t=312

- `solo`, `mute` — comma-separated stem ids: `guitar`, `bass`, `keys`, `drums`, `vocals`
- `g` — fader gains as `stem:value` pairs, 0 to 1.5 (1 is unity)
- `t` — position in seconds; the player seeks there but waits for Play

The player keeps the hash current as you mix and the Share button (or `L`)
copies it with the current position.

## Guides

A guide is a listening tour of a song: an ordered list of tips, each a
passage, a mix, and a note. The mix holds for the passage and the band plays
in full between tips; when the playhead reaches a tip its note is shown.

To write one, press **+ New guide** under the song title, play the song, set mute/solo, and press `N` (or
**Tip: Start**) where a passage worth a tip begins. The tip takes that
moment and the mix in force, and runs to the next tip unless given an end.
The list shows one line per tip with edit, play and delete; edit opens that
tip alone, with its start, optional end and description, and a play button
that loops the passage. Start and end are set from the playhead: scrub or
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
  player or a list of players: `guitar`, `bass`, `keys`, `drums`, `vocals`),
  `gain` (a map of player to fader level, 0 to 1.5), `pause` and `note`. A
  later tip may start before the one before it ends, which is how a passage
  is replayed.
- `pause: true` stops the music at the tip until the listener presses Continue.
- A note that holds a colon followed by a space, or a `#`, needs quotes, as
  YAML has it: `note: "Trey: listen for the bend"`.

Guides kept in the repo live at `guides/<song id>/<slug>.yaml` in the form
above, listed by slug under the song id in `guides.json`; they appear as
pills under the song and open with `guide=<slug>`. `guides.json` is derived
from the files: the deploy workflows regenerate it before publishing, and
`python3 scripts/guides-index.py` rewrites it locally (`--lint` only
checks the guides, `--check` also tells whether `guides.json` is current).
The script parses every guide strictly, as the player would, and fails on
a file that is not YAML, an unknown player or key, a field of the wrong
kind, a missing title or a folder that is not a song id: a pull request with a broken guide fails its
"Check data" workflow, and a merged one fails the deploy.

To offer a guide to the library, press **Contribute** on a guide you wrote
(or one that reached you by link). A sheet asks for the title, your name,
an optional link for it and the notes' language, shows the text as it will
be submitted, and opens GitHub with the file ready at
`guides/<song id>/<slug>.yaml`. Committing it there proposes the change as a
pull request (GitHub forks the repo for anyone without push access), and the
single new file is the whole contribution. **Copy text** is for sending the
guide some other way. The title, name and link are written into the guide's
link as well.

A guide travels in the link: `#songid&guide=<slug>` for one in the repo, or
`guide=z…`, the deflated text, for one written in the player or by hand. To
make such a link by hand, open the song, then in the browser console:

    await SplitOpen.guideLink(`title: ...
    tips:
      - at: 0:00
        solo: [drums]
        note: ...`)

A dozen tips with a sentence each come to about a kilobyte of link.

Run locally with `python3 scripts/serve.py` (a static server that turns
caching off, so a reload always gets the current files) and open
`http://localhost:8765/`. Any static server from the repo root works too.
The scripts need PyYAML (`python3 -m pip install pyyaml`); the workflows
install it when the runner lacks it.

The site is served by GitHub Pages from the `gh-pages` branch, which a
workflow refreshes from `main` on every push. Each pull request gets a
preview at `https://weitzman.github.io/splitopen/pr-preview/pr-<number>/`,
linked from a comment on the PR and removed when it closes. Links to the
old `/web/` path redirect to the root.

Source recordings come from the [Live Music Archive](https://archive.org/details/etree)
and are for non-commercial listening only.
