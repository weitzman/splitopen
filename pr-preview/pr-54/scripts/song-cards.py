#!/usr/bin/env python3
"""Renders the link-preview cards: one per song under s/<id>/card.png, and
with --site the site's own social.png.

A card is the player as it looks with the song loaded (logo, title, venue
line, a strip per band member with fader and Mute/Solo, the transport),
drawn at 1200x630 by headless Chrome from the template below. The song
pages (scripts/song-pages.py) name their card as og:image, so a shared song
unfurls with its own title and lineup rather than the site's card.

The song cards are derived, so they are written at deploy time after
song-pages.py (which empties s/ first). social.png is committed; rerun
with --site after changing the template or the first band's lineup.

    python3 scripts/song-cards.py            # s/<id>/card.png for every song
    python3 scripts/song-cards.py --site     # ...and social.png
    python3 scripts/song-cards.py --site --only  # social.png alone

Chrome is found at $CHROME, else google-chrome / chromium on PATH, else the
Mac app bundle.
"""
import html
import os
import shutil
import subprocess
import sys
import tempfile
from string import Template

import yaml12

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
OUT = 's'
COLORS = {
    'guitar': '#ff6b35', 'bass': '#3dd6a3', 'keys': '#a66cff', 'drums': '#d7263d',
    'vocals': '#f2b134', 'horns': '#4cc9f0', 'flute': '#c3f06b',
}
STEMS = list(COLORS)
# Meter levels, so the band looks mid-song; one per strip, in stem order.
LEVELS = [72, 58, 44, 81, 36, 50, 40]
CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

PAGE = Template("""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b1026;--bg-2:#141b3a;--panel:rgba(20,27,58,.85);--line:rgba(255,255,255,.08);--text:#f4efe6;--muted:#9aa0b8;--gold:#f2b134;--donut:#d7263d}
*{box-sizing:border-box}
html,body{margin:0}
body{width:1200px;height:630px;overflow:hidden;position:relative;background:radial-gradient(1400px 700px at 50% -10%,var(--bg-2),var(--bg) 70%);color:var(--text);font-family:Inter,sans-serif}
.backdrop{position:absolute;inset:0;opacity:.07;background:url(${rings}) 0 0/320px 64px repeat}
.app{position:relative;height:100%;display:flex;flex-direction:column;padding:26px 60px 28px}
.logo{display:flex;align-items:center;gap:12px}
.mark{width:52px;height:33px}
.logo-text{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:25px;letter-spacing:-.01em}
.show{text-align:center;margin-top:-22px}
h1{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:${title_size}px;line-height:1;margin:0;letter-spacing:-.03em;white-space:nowrap;text-shadow:0 0 28px rgba(242,177,52,.25)}
.venue{margin-top:12px;font-size:19px;color:var(--muted)}
.venue u{text-decoration:underline;text-underline-offset:4px}
.tag{margin-top:14px;font-size:26px;color:var(--muted);line-height:1.3}
.tag b{color:var(--text);font-weight:600}
.strips{margin-top:22px;display:grid;grid-template-columns:repeat(${n},minmax(0,190px));justify-content:center;gap:14px}
.strip{--c:var(--gold);background:var(--panel);border:2px solid var(--c);border-radius:12px;padding:16px 12px 14px;display:flex;flex-direction:column;align-items:center;gap:8px}
.who{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:${who_size}px;letter-spacing:-.02em;color:var(--c);line-height:1;white-space:nowrap}
.inst{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;white-space:nowrap}
.mf{display:flex;gap:12px;align-items:stretch;height:${fader}px;margin:6px 0 4px}
.meter{width:10px;background:rgba(0,0,0,.4);border-radius:5px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
.fill{width:100%;background:linear-gradient(to top,var(--c),var(--gold) 80%,var(--donut))}
.track{width:6px;background:rgba(255,255,255,.15);border-radius:3px;position:relative;margin:0 6px}
.thumb{position:absolute;left:50%;top:${thumb}px;width:18px;height:28px;margin-left:-9px;border-radius:4px;background:var(--c);border:2px solid var(--bg);box-shadow:0 2px 6px rgba(0,0,0,.5)}
.btns{display:flex;gap:8px}
.btn{font:700 13px Inter;letter-spacing:.05em;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--text);display:grid;place-items:center}
.bar{margin-top:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;height:58px;display:flex;align-items:center;gap:16px;padding:0 14px}
.play{width:36px;height:36px;border-radius:50%;background:var(--gold);display:grid;place-items:center}
.play svg{width:14px;height:14px;margin-left:2px}
.time{font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums}
.line{flex:1;height:4px;background:rgba(255,255,255,.15);border-radius:2px;position:relative}
.line i{position:absolute;left:0;top:50%;width:14px;height:14px;margin:-7px 0 0 -2px;border-radius:50%;background:var(--gold)}
.share{width:30px;height:30px;border-radius:7px;border:1px solid var(--line);background:rgba(255,255,255,.06);display:grid;place-items:center}
.share svg{width:15px;height:15px}
</style></head><body>
<div class="backdrop"></div>
<div class="app">
  <div class="logo">
    <svg class="mark" viewBox="0 0 64 40"><path d="M2 20h6l4-14 6 28 5-20 4 12 3-6h6" fill="none" stroke="#f4efe6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 20c10 0 10-16 24-16" fill="none" stroke="#ff6b35" stroke-width="3" stroke-linecap="round"/><path d="M36 20c10 0 10-8 24-8" fill="none" stroke="#3dd6a3" stroke-width="3" stroke-linecap="round"/><path d="M36 20h24" fill="none" stroke="#a66cff" stroke-width="3" stroke-linecap="round"/><path d="M36 20c10 0 10 8 24 8" fill="none" stroke="#d7263d" stroke-width="3" stroke-linecap="round"/><path d="M36 20c10 0 10 16 24 16" fill="none" stroke="#f2b134" stroke-width="3" stroke-linecap="round"/></svg>
    <span class="logo-text">Split Open</span>
  </div>
  <div class="show">
    <h1>${title}</h1>
    ${under}
  </div>
  <div class="strips">${strips}</div>
  <div class="bar">
    <div class="play"><svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z" fill="#1a1200"/></svg></div>
    <span class="time">0:00</span>
    <div class="line"><i></i></div>
    <div class="share"><svg viewBox="0 0 24 24" fill="none" stroke="#f4efe6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16"/><path d="M12 15V3M8 7l4-4 4 4"/></svg></div>
  </div>
</div>
</body></html>
""")

STRIP = Template("""<div class="strip" style="--c:${color}"><div class="who">${who}</div><div class="inst">${inst}</div>
<div class="mf"><div class="meter"><div class="fill" style="height:${level}%"></div></div><div class="track"><div class="thumb"></div></div></div>
<div class="btns"><div class="btn">Mute</div><div class="btn">Solo</div></div></div>""")


def load_yaml(name):
    with open(os.path.join(ROOT, name), encoding='utf-8') as f:
        return yaml12.load(f.read())


def lineup(song, band):
    """[(stem, who, inst)] in stem order: the band's lineup with the song's overrides."""
    channels = dict(band['channels'])
    for stem, ch in (song.get('channels') or {}).items():
        channels[stem] = {**channels.get(stem, {}), **ch}
    return [(stem, channels[stem]['who'], channels[stem]['inst']) for stem in STEMS if stem in channels]


def esc(s):
    return html.escape(str(s), quote=True)


def page(title, under, players, tagline=False):
    n = len(players)
    # The faders stand taller when the venue line is short, and the strips
    # narrow their names when there are many.
    fader = 165 if tagline else 190
    strips = ''.join(STRIP.substitute(
        color=COLORS[stem], who=esc(who), inst=esc(inst), level=LEVELS[i % len(LEVELS)])
        for i, (stem, who, inst) in enumerate(players))
    return PAGE.substitute(
        rings='file://' + os.path.join(ROOT, 'bg-rings.svg'),
        title=esc(title), under=under, strips=strips, n=n,
        title_size=76 if len(title) <= 14 else 62 if len(title) <= 22 else 50,
        who_size=24 if n <= 5 else 20,
        fader=fader,
        # The thumb sits at unity, 1 of 0..1.5 from the bottom of the track.
        thumb=round((1 - 1 / 1.5) * (fader - 28)),
    )


def song_page(song, band):
    parts = [f'<u>{esc(song["date"])}</u>', esc(band.get('short_name') or band['name']),
             esc(song['venue']), esc(song['city'])]
    under = '<div class="venue">' + ' · '.join(parts) + '</div>'
    return page(song['title'], under, lineup(song, band))


def site_page(band):
    under = ('<div class="tag">Live recordings, one player per band member.<br>'
             '<b>Mute</b>, <b>solo</b>, and mix each stem to hear how the music works.</div>')
    players = [(stem, ch['who'], ch['inst']) for stem, ch in band['channels'].items()]
    return page('Split Open', under, players, tagline=True)


def chrome():
    for c in [os.environ.get('CHROME'), shutil.which('google-chrome'), shutil.which('chromium'),
              shutil.which('chromium-browser'), CHROME_MAC]:
        if c and os.path.exists(c):
            return c
    raise SystemExit('song-cards: no Chrome found; set $CHROME')


def render(html_text, out, browser, tmp):
    src = os.path.join(tmp, 'card.html')
    with open(src, 'w', encoding='utf-8') as f:
        f.write(html_text)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    subprocess.run([browser, '--headless=new', '--hide-scrollbars', '--disable-gpu', '--no-sandbox',
                    '--virtual-time-budget=8000', '--window-size=1200,630',
                    '--screenshot=' + out, 'file://' + src],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main(argv):
    songs = load_yaml('songs.yaml')
    bands = load_yaml('bands.yaml')
    browser = chrome()
    with tempfile.TemporaryDirectory() as tmp:
        if '--site' in argv:
            first = bands[songs[0]['band']]
            render(site_page(first), os.path.join(ROOT, 'social.png'), browser, tmp)
            print('social.png')
        if '--only' in argv:
            return
        for song in songs:
            out = os.path.join(ROOT, OUT, song['id'], 'card.png')
            render(song_page(song, bands[song['band']]), out, browser, tmp)
        print(f'{OUT}/: {len(songs)} song cards')


if __name__ == '__main__':
    main(sys.argv[1:])
