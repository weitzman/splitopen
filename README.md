# Stemmy

Web site: https://weitzman.github.io/stemmy/

A stem mixer for live recordings: each band member on a separate
channel with mute, solo, and a fader, playing in sync.

- `web/` — the player (static HTML + Web Audio API, no build step)
- `audio/songs/<id>/` — five MP3 stems per song: guitar, bass, keys, drums, vocals
- `scripts/add-song.sh` — download a FLAC from archive.org, separate it with
  BS-Roformer-SW (`audio-separator`), encode the stems, register the song in
  `web/songs.json`

Run locally with any static server from the repo root, e.g.
`python3 -m http.server 8765`, then open `http://localhost:8765/web/`.

Source recordings come from the [Live Music Archive](https://archive.org/details/etree)
and are for non-commercial listening only.
