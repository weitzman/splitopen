# Split Open

Web site: https://weitzman.github.io/splitopen

A stem mixer for live recordings: each band member on a separate
channel with mute, solo, and a fader, playing in sync.

- `web/` — the player (static HTML + Web Audio API, no build step)
- `audio/songs/<id>/` — five MP3 stems per song: guitar, bass, keys, drums, vocals
- `scripts/add-song.sh` — download a FLAC from archive.org, separate it with
  BS-Roformer-SW (`audio-separator`), encode the stems, register the song in
  `web/songs.json`
- `scripts/social-card.html` — source for `web/social.png`, the link-preview image.
  Regenerate after editing it with headless Chrome:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --virtual-time-budget=8000 --window-size=1200,630 --screenshot=web/social.png file://$PWD/scripts/social-card.html`

Run locally with any static server from the repo root, e.g.
`python3 -m http.server 8765`, then open `http://localhost:8765/web/`.

Source recordings come from the [Live Music Archive](https://archive.org/details/etree)
and are for non-commercial listening only.
