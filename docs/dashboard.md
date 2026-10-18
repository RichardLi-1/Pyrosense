# Design: Dashboard

One screen. The judge should understand it in five seconds and be impressed in ten.

## Stack

React 18 + Vite, TypeScript. Rendering on `<canvas>` (not SVG, not D3 for the map). Tailwind for the chrome. Fonts: **Inter** (UI) + **JetBrains Mono** (numbers). Dark theme only.

## Layout (16:9 laptop, 1440×900 target)

```
┌──────────────────────────────────────────────────────────┬────────────────────────┐
│  PROJECT_NAME            ● LIVE   session utsc-sw-14h    │   VOC INDEX            │
│                                                          │   ┌────────────────┐   │
│                                                          │   │     183        │   │
│                                                          │   │   MODERATE     │   │
│                                                          │   └────────────────┘   │
│                    MAP CANVAS                            │   ▁▂▃▅▆▇▅▃▂▁▂▃ 60 s   │
│                                                          │                        │
│   L1 occupancy grid                                      │   STATUS               │
│   L2 heat layer                                          │   142 m² mapped        │
│   L3 trail                                               │   1,842 samples        │
│   L4 person dot + heading                                │   23:41:07  ·  00:12:34│
│   L5 alert ring (on event)                               │                        │
│                                                          │   ALERTS               │
│                                                          │   ⚠ 23:40:52  idx 412  │
│                                                          │     near (4.3, −1.1)   │
│                                                          │     [thumbnail]        │
│                                                          │                        │
│                                                          │   SUMMARY  ✦ Gemini    │
│                                                          │   "Elevated VOC is     │
│                                                          │    concentrated in…"   │
│                                                          │   [Regenerate]         │
├──────────────────────────────────────────────────────────┴────────────────────────┤
│  ◀ ▶  ━━━━━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  LIVE    │
│  14:02:10                                                             14:14:44   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

Map canvas ≈ 70 % width. Right rail fixed 360 px. Bottom strip 56 px.

## Map canvas layers (back to front)

| # | Layer | Source | Redraw | Style |
|---|---|---|---|---|
| 0 | Background | — | once | `#0b0e14`, subtle 1 m grid at 6 % white |
| 1 | Occupancy grid | `/map` (PNG + origin/res via `/ws/live` map event) | on map change (~1 Hz) | Occupied → `#e6e8ec` at 85 %; free → `#151a24`; unknown → transparent. Draw via offscreen `ImageData` then `drawImage` scaled; `imageSmoothingEnabled = false` for crisp walls |
| 2 | Heat layer | `/heatmap` (poll 2 s) or in-browser grid | on new data | Cells as rects, colour = LUT(mean), alpha = weight; separate canvas with `filter: blur(6px)`; composite `screen` |
| 3 | Trail | `/trail` + live poses appended | every pose | Polyline, 2 px, colour = LUT(voc at that point), alpha fading with age over 5 min |
| 4 | Person | `/ws/live` pose @10 Hz | every rAF | 12 px dot `#4f8cff`, heading wedge, soft outer pulse (1.5 s cycle). **Interpolate** between the last two poses with `lerp` over 100 ms so motion glides |
| 5 | Alert ring | `/ws/live` alert event | on event | Red ring expands from the person over 1.2 s and fades; canvas edge vignette flashes red for 400 ms |

### View transform

Keep a single `camera = {cx, cy, scale}` in map metres. Default: fit the known map extent with 10 % padding, recompute on map growth (lerp the camera so it doesn't snap). Toggle **Follow** mode: camera centres on the person. Mouse wheel zooms, drag pans, double-click resets.

World → screen: `sx = (x − cx)·scale + W/2`, `sy = H/2 − (y − cy)·scale` (flip Y; ROS is right-handed, +y is up on screen).

### Heat LUT

```
0.00  rgba(0,0,0,0)
0.20  #1dd3b0   teal
0.50  #ffd166   yellow
0.75  #ff8c42   orange
1.00  #ef233c   red
```
Input normalised over `[0, 500]` (SGP40 index). Alpha = `min(1, weight / W_ref)`.

## Right rail

- **VOC gauge**: big mono number (72 px), level label beneath, background tinted with the level colour at 12 %. Sparkline of the 60 s window, 320×48, same LUT for the line.
- **Status**: area mapped (count free cells × res²), samples ingested, wall clock, session elapsed.
- **Alerts**: newest first, max 5 shown. Each: time, index, nearest coordinates, 96×64 map thumbnail with the person's position marked. Click → camera jumps there.
- **Summary**: Gemini text, max ~80 words, with a `✦ Gemini` tag and a Regenerate button. Skeleton shimmer while loading.

## Bottom strip: time scrubber

- Range = session start → now. Handle at the right edge = LIVE.
- Dragging left: switch to replay mode. `/heatmap?until=T`, `/trail?until=T` re-fetched (debounced 150 ms), person dot moves to the pose nearest T from the trail. Live WS still connected but paused.
- Releasing at the far right returns to LIVE.
- Play/pause buttons animate T at 10× real time.

## Interactions

| Action | Result |
|---|---|
| `F` / Follow button | Toggle follow mode (camera tracks the selected responder) |
| `H` `U` `T` `S` `N` `A` `M` | Toggle layers: gas map, uncertainty fog (GP sd), responder paths, source estimate, sample next, alerts, annotations. Same switches in the **Layers** popover |
| All / FF-n (rail) | Show every responder, or one (others dimmed, their paths and alerts hidden) |
| Exposure (header) | Per-responder cumulative dose this session, shared time axis and scale; hover to read everyone at one moment |
| Mark toolbar (right) | Pick victim / fire / blocked exit / exit / stairs / hazard, then click the map (or *At FF-n's position*, `Enter`); `Esc` cancels. Stored per session in this browser |
| Click alert | Camera jumps to it |
| Click map | Tooltip: cell mean, samples, last measured |

## Colour tokens

```css
--bg:        #0b0e14;
--panel:     #11161f;
--border:    #1f2733;
--text:      #e6e8ec;
--muted:     #8b94a7;
--accent:    #4f8cff;   /* person */
--good:      #1dd3b0;
--moderate:  #ffd166;
--poor:      #ff8c42;
--alert:     #ef233c;
```

## Data hooks

| Hook | Transport | Notes |
|---|---|---|
| `useLive(session)` | WS `/ws/live` | Returns `{pose, voc, mapMeta, alerts}`; auto-reconnect with backoff |
| `useHeatmap(session, until, halfLife)` | GET `/heatmap` | SWR, 2 s refresh when live, on-demand when scrubbing |
| `useTrail(session, since)` | GET `/trail` | Initial fetch, then live poses appended client-side |
| `useMapImage(url)` | GET `/map` PNG | Decodes to `ImageBitmap` |
| `useSummary(session)` | GET `/summary` | Manual trigger + auto every 2 min |

## Performance budget

- 60 fps with the person dot moving; heat layer redraw ≤ 16 ms for ≤ 5 000 cells.
- Occupancy grid redraw off the main thread if `/map` exceeds 2 000×2 000 (unlikely for one floor).
- Never block on a fetch inside the rAF loop.

## Empty / error states

- No map yet: faint "Waiting for first scan…" with a spinner in the canvas centre.
- WS disconnected: LIVE pill turns grey, "Reconnecting…", last known state stays on screen.
- Replay with no backend: load a `session.json` from `/public` and drive everything from it (demo fallback).

## Don'ts

- No pie charts, no second map, no 3D.
- No panel that needs a legend to understand.
- No animation that runs when nothing changed.
