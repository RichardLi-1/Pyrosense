# Backend

FastAPI process that ingests the Pi's ROS topics over **foxglove_bridge**, keeps a live
in-memory state for the dashboard, batch-writes readings into Tiger Data, runs the
exposure alert engine, and produces the Gemini walk summary. Spec: `docs/backend-architecture (2).md`.

```
foxglove_bridge ws://pi:8765 ──▶ app/foxglove.py (Foxglove WS protocol, CDR decode)
                                   └─▶ app/ingest.py ──▶ app/state.py   (cache + /ws/live fan-out)
                                                      ├─▶ app/db.py      (1 s COPY batches → readings)
                                                      └─▶ app/alerts.py  (threshold · hold · cooldown)
app/api.py: /ws/live /heatmap /trail /map /alerts /summary /sessions /session /health
```

## Run locally (no hardware)

```bash
cd backend
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e ".[dev]"
cp .env.example .env            # edit if needed

# 1. database (TimescaleDB in Docker, host port 5433)
(cd .. && docker compose -f docker-compose.dev.yml up -d \
       && docker compose -f docker-compose.dev.yml exec -T timescaledb psql -U postgres -d app < db/schema.sql)

# 2. fake Pi: a Foxglove server publishing /pose, /map, /voc_points (VOC spike after 20 s)
.venv/bin/python -m tools.fake_pi --port 8765 --spike-at 20

# 3. API
BRIDGE_URL=ws://localhost:8765 DATABASE_URL=postgresql://postgres:postgres@localhost:5433/app \
  .venv/bin/uvicorn app.main:app --port 8000 --reload
```

Then `curl localhost:8000/health`, open `http://localhost:8000/docs`, or connect a WebSocket to
`ws://localhost:8000/ws/live`. Point `BRIDGE_URL` at the Pi's Tailscale IP for the real thing.

Tests: `make test` from the repo root. DB tests (`tests/test_db.py`) run against a throwaway `hazard_test` database when `make db` is up and skip otherwise.

## Why not roslibpy

`foxglove_bridge` speaks the Foxglove WebSocket protocol (`foxglove.websocket.v1`), not the
rosbridge JSON protocol that `roslibpy` implements. `app/foxglove.py` is a small native client:
it reads the `advertise` message (topic, `schemaName`, ros2msg schema text), builds a CDR decoder
per channel with `mcap_ros2`, subscribes, and decodes the binary `MessageData` frames. Nothing
ROS-specific is installed on the backend host.

## `/ws/live` events

| `t` | Fields | When |
|---|---|---|
| `hello` | `session, started, threshold, unit, bridge_connected, n_samples, voc_window[[t,voc]…]` | on connect, on session change |
| `map` | `url, version, origin[x,y], res, w, h, y_up, free_area_m2, ts` | every `/map` message (≈1 Hz) |
| `pose` | `ts, x, y, heading, voc` | ≤10 Hz |
| `voc` | `ts, voc, n_new, x, y` | each new `/voc_points` sample |
| `sensor` | `ts, voc, unit, eco2, raw_h2, raw_ethanol, temperature, humidity, warmed_up` | each raw `/voc` frame (2 Hz); latest copy also in `hello.sensor` |
| `alert` | `id, ts, x, y, voc, threshold, map_png_url` | alert engine fires |
| `bridge` | `connected` | Pi link up/down |

`/map` returns a north-up RGBA PNG (image row 0 = max y) with `X-Map-Origin`, `X-Map-Res`,
`X-Map-Size`, `X-Map-Version` headers. Pixel `(col,row)` covers world
`x = origin.x + col·res`, `y = origin.y + (h − row)·res`.

## REST

| Route | Notes |
|---|---|
| `GET /heatmap?session=&until=&half_life=120` | `{cells:[{cx,cy,mean,weight,sd,n}], cell_size:0.2, …}` from `voc_cells` with exponential decay; `until` drives the scrubber |
| `GET /trail?session=&since=&until=&limit=` | `[{ts,x,y,heading,voc}]` from `readings` |
| `GET /map?session=` · `GET /map/meta` | live occupancy PNG / its metadata |
| `GET /alerts?session=` · `GET /alerts/{id}/map.png` | history + map snapshot at alert time |
| `GET /summary?session=&force=` | Gemini report (cached 60 s); deterministic fallback text when no key |
| `GET /sessions` | sessions in `readings`, joined with saved name/notes and `map_png_url` |
| `POST /session/save` `{name, notes}` | name the current scan and store its floor plan (catalog) |
| `POST /session/restart` `{name?}` | save current, ask the Pi (`:8766/restart`) to restart SLAM + VOC buffer, open a new session |
| `GET /sessions/{id}/map.png` | saved floor plan of a past session |
| `GET/POST /session` | current session id; POST `{session}` to start a new walk |
| `GET /health` | bridge/db/ws status |

Timestamps accept ISO‑8601 or unix seconds. `session` defaults to the live session.

## VOC units

The sensor on the rig is an **SGP30**, which reports TVOC in **ppb** (not the SGP40 0-500 index).
`VOC_UNIT=ppb` (default) selects the ppb bands: <220 good · 220-660 moderate · 660-2200 poor · >2200 alert,
`VOC_THRESHOLD` defaults to 2200, and the summary/heat scale run 0-3000. Set `VOC_UNIT=index` and
`VOC_THRESHOLD=250` for an SGP40. The `hello` event on `/ws/live` carries `unit` and `threshold` so the
dashboard can pick its colour scale from it.

## Behaviour under failure

- **DB down**: ingest keeps going; readings buffer in memory (newest 50 000) and flush when the
  connection returns; DB-backed routes answer 503. `/ws/live`, `/map` keep working.
- **Bridge down**: reconnects with backoff (1 → 15 s); `bridge` event + `/health` reflect it.
- **No Gemini key**: `/summary` returns `source: "fallback"` text built from the same stats.

## Deploy (Vultr)

`docker-compose.yml` at the repo root: `timescaledb` + `api` + `nginx` (serves `dashboard/dist`,
proxies `/api/*` → API root and `/ws/*`). Apply `db/schema.sql` once after first boot.
