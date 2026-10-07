# Split Open

Our favorite songs, [Split Open](https://weitzman.github.io/splitopen) so we can learn and appreciate.

A stem mixer for live recordings: each band member on a separate
channel with mute, solo, and a fader, playing in sync.

- `index.html`, `app.js`, `styles.css`, `songs.json`, `bands.json` — the player
  (static HTML + Web Audio API, no build step), served from the repo root
- `audio/songs/<id>/` — five Opus stems per song (128 kbps, Ogg container): guitar, bass, keys, drums, vocals
- `scripts/add-song.sh` — download a FLAC from archive.org, separate it with
  BS-Roformer-SW (`audio-separator`), encode the stems, register the song in
  `songs.json`
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

The player keeps the hash current as you mix and the Copy link button (or `L`)
copies it with the current position.

Run locally with any static server from the repo root, e.g.
`python3 -m http.server 8765`, then open `http://localhost:8765/`.

The site is served by GitHub Pages from the `gh-pages` branch, which a
workflow refreshes from `main` on every push. Each pull request gets a
preview at `https://weitzman.github.io/splitopen/pr-preview/pr-<number>/`,
linked from a comment on the PR and removed when it closes. Links to the
old `/web/` path redirect to the root.

Source recordings come from the [Live Music Archive](https://archive.org/details/etree)
and are for non-commercial listening only.
