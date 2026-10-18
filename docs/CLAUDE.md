# CLAUDE.md — Project context

Read this first. It captures everything decided so far so you can work without re-asking.

## What we're building

A **wearable indoor air-quality mapper** for Hack the Valley 11 (UTSC, Oct 16–18 2026, submission deadline **Sat Oct 18, 8:00 AM EDT**).

A person wears a 2D LiDAR + VOC sensor on a Raspberry Pi 5. As they walk a building, the Pi runs SLAM to build a floor plan and track the wearer's position, and stamps each gas reading to a map location. A web dashboard shows, in real time:

- the floor plan filling in (occupancy grid)
- the wearer's live position and heading
- a **gas-concentration heat map** overlaid on the floor plan (kernel-weighted mean per cell, opacity = confidence, time decay)
- a live VOC gauge, sparkline, alert panel, Gemini-generated plain-English summary, and a time scrubber for replay

**Pitch line:** *A wearable that maps a building's air as you walk it — live floor plan, your position, and a gas heat map — and flags exposure before you'd notice it yourself.*

Project name: **PyroSense**.

## Team setup

- **Pi 5** (Ubuntu 24.04, ROS 2 Jazzy) — the only ROS machine. Headless; everyone works on it via **SSH / VS Code Remote-SSH**. Long-running stack lives in a shared **tmux** session named `ros`.
- **Macs** — no ROS installed. Foxglove Studio for debugging (connects to the Pi's bridge over WebSocket). RViz only if someone spins up a UTM Ubuntu VM; not required.
- **Vultr VM** (`216.128.184.212`) — Docker Compose: FastAPI backend + nginx serving the dashboard and landing page. Deploy with `./deploy/deploy.sh`. Pi ↔ VM connectivity via **Tailscale**.
- **Tiger Cloud** (Tiger Data) — the database: managed Postgres + TimescaleDB, reached from the VM over TLS via `DATABASE_URL`.

## Hardware

| Part | Model | Interface | Notes |
|---|---|---|---|
| LiDAR | Slamtec **RPLIDAR C1** (A1 acceptable fallback) | USB serial, 460800 baud | 10 Hz, ~500 pts/rev, 0.05–12 m, ±30 mm. Must be mounted level, unobstructed 360° |
| Compute | Raspberry Pi 5 | — | Active cooling recommended |
| VOC | **Sensirion SGP30** (I²C 0x58) | I²C | TVOC in **ppb** (+ eCO₂ ppm). ~15 s init, baseline matures over hours; 10–60 s response lag |
| IMU | Optional, **not in v1** | I²C | Add only if heading drifts on turns |
| Power | USB power bank | — | LiDAR + Pi ≈ 8–10 W |

Static transforms to measure with a ruler: `base_link → laser` (laser height above body origin), `base_link → voc_link`.

## Architecture (summary — see docs for detail)

```
Pi: rplidar_ros → /scan → rf2o_laser_odometry (tf odom→base_link)
                        → slam_toolbox (/map, /pose, tf map→odom)
    voc_driver → /voc → voc_mapper (tf lookup map→base_link at t − lag) → /voc_points
    static_transform_publisher → /tf_static
    foxglove_bridge (ws :8765)  ← single exit from the Pi
    ros2 bag record             ← always on, demo fallback

Vultr VM: FastAPI (Foxglove WS ingest → cache + write buffer; REST + /ws/live;
                   alert + spoken-warning engines; Gemini, ElevenLabs)
          nginx → dashboard static build (+ /landing/), /api and /ws proxied to FastAPI
Tiger Cloud: readings hypertable, voc_cells continuous aggregate (the heat map),
             alerts, sessions_meta (saved scans)
```

Docs:
- `backend-architecture (2).md` — full backend diagram, endpoints, schema, Vultr + Tiger Cloud deployment
- `pi-ros-stack.md` — nodes, frames, launch file, config, debugging
- `voc-mapping.md` — the heat-map algorithm and its justification
- `dashboard.md` — UI layout, layers, palette, interactions

## Key technical decisions (don't relitigate)

1. **slam_toolbox + rf2o**, not Hector. slam_toolbox needs an `odom` frame; rf2o fakes one from LiDAR. Gives loop closure and a maintained codebase.
2. **Frame chain:** `map → odom → base_link → laser`. slam_toolbox owns `map→odom`, rf2o owns `odom→base_link`, static publisher owns `base_link→laser`.
3. **The dashboard talks only to FastAPI**, never to the bridge. Foxglove is the only thing that hits the bridge directly besides the ingest worker.
4. **Heat map is computed in Tiger Data** (continuous aggregate, 20 cm cells, 10 s buckets) with decay applied in the `/heatmap` query. Rendered client-side: colour = mean, opacity = weight.
5. **Sensor lag is corrected at the source:** `voc_mapper` looks up the pose at `t − SENSOR_LAG_SECONDS` (default 12 s, calibrate with a marker test).
6. **No Twilio / KAZE integration for now.** Alert engine writes to `alerts` table and emits an event on `/ws/live`. That's the hook if we add it.
7. **IMU is v2.** Get LiDAR-only mapping working and walk a loop first.
8. **Record a rosbag the moment mapping works.** Replay is the demo safety net.

## Prize tracks we're submitting to

| Track | Our angle | Needs code? |
|---|---|---|
| **Top 3** | Default | — |
| **Best Use of Tiger Data** (MLH) | Tiger Cloud: hypertable ingest + continuous aggregate *is* the heat map; replay and the scan catalog via time-range queries; compression policy | Done |
| **Best Use of Gemini API** (MLH) | Walk summary: top cells + heat PNG → plain-English report in the dashboard | Yes — `/summary` |
| **Best Use of Vultr** (MLH) | Backend, dashboard and landing page hosted on a Vultr VM (Docker Compose, one-command deploy) | Done |
| **Best Domain Name** (GoDaddy, MLH) | Register project domain, TLS via certbot | Trivial |
| **Best Healthcare & Well-being Hack** | Indoor air quality → respiratory health, headaches, cognition | Framing |
| **Best Climate Action / Sustainability** | Shows where ventilation/HVAC isn't reaching; targeted fixes vs blanket ventilation | Framing |
| **PointClickCare: Catch It Early** | Care staff walk the floor once a shift; map flags poorly ventilated rooms before residents show symptoms. Target user = care team | One slide |
| **Best AI for Social Impact** | Gemini summary + alerting | Framing |
| **Swapna Samuel: Project KAZE** | *Possible later:* exposure alert with location when wearer can't call for help. Only if Twilio/contact flow gets built | Not now |

Skipping: School of Cities, Solana, FDM (maybe one sentence), DEV writing (post-event).

## Judging criteria to design against

Technicality & quality (working demo) · Design (UI polish) · Impact · Presentation (4 min pitch + 1 min Q&A) · Inspiration · Authenticity.

## Priority order (32 h)

1. LiDAR → slam_toolbox producing a map on the Pi; Foxglove showing it. **Record a bag.**
2. VOC driver + mapper publishing `/voc_points`. Dashboard rendering map + dot from FastAPI.
3. Heat layer, trail, gauge. Alert engine. Tiger Data ingest + aggregate.
4. Gemini summary, Vultr deploy, time scrubber off recorded data.
5. Polish, demo video, Devpost write-up. **Stop adding features Sunday 2 AM.**

## Conventions

- Python 3.12, `rclpy` on the Pi; FastAPI + `asyncpg` + a Foxglove WebSocket client on the backend; React + Canvas (Vite) frontend.
- ROS package names: `voc_sensor` (driver + mapper + `VocReading.msg`), `wearable_bringup` (launch + config).
- Topic names are fixed: `/scan`, `/map`, `/pose`, `/voc`, `/voc_points`. Frame names: `map`, `odom`, `base_link`, `laser`, `voc_link`.
- Every reading carries a `session` id (set at launch, e.g. `utsc-sw-2025-10-17-14h`).
- Secrets in `.env`, never committed. `GEMINI_API_KEY`, `DATABASE_URL`, `BRIDGE_URL`.
- Commit often; the Pi workspace is a git repo, Macs pull/push to it.

## Demo essentials

- Live trigger: uncap a **dry-erase marker** or spray **hand sanitizer** near the sensor → VOC spikes in seconds → heat blooms, alert fires.
- Fallback: `ros2 bag play` on the Pi, or open a saved scan from the catalog (Tiger Cloud) and scrub it.
- Have the device visible and wearable on the table.

## Glossary (for anyone new)

- **SLAM** — simultaneous localization and mapping; builds the floor plan and tracks position from LiDAR scans.
- **Occupancy grid** — the map: a bitmap of cells marked free / occupied / unknown.
- **tf / tf2** — ROS's shared coordinate-frame tree; every node reads and writes transforms on `/tf`.
- **DDS** — the pub/sub middleware under ROS 2 topics; runs over UDP on the LAN.
- **Bridge** — `foxglove_bridge` (or `rosbridge`): re-emits ROS topics over WebSocket so non-ROS clients can subscribe.
- **Continuous aggregate** — Tiger Data/Timescale materialized view that updates incrementally; ours bins readings into cells.
