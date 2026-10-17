# Design: VOC heat-map algorithm

How a stream of (time, VOC) readings from a moving sensor becomes a 2D concentration map with confidence.

## Problem

- We sample only along the walked path, not on a grid. Everything between samples is interpolation.
- Readings are noisy and disagree between passes.
- The sensor lags 10–60 s: the value read in the doorway is partly the hallway behind you.
- The field changes: windows open, sources disperse, we revisit rooms.

A raw scatter plot is honest but flickery and tells the judge nothing about how sure we are. We want: smooth heat, stable hot spots, visible uncertainty, and a one-sentence defensible method.

## Method: kernel-weighted mean + variance per cell, with time decay

A lightweight approximation of a Gaussian process, following the kernel DM+V approach (Lilienthal et al.) used in gas distribution mapping.

### Per reading

For reading `(x, y, v)` at time `t`:

```
for each cell c within radius R of (x, y):
    w  = exp(-d(c, (x,y))² / (2σ²))
    W[c]  += w
    S[c]  += w·v
    S2[c] += w·v²
```

Per cell, at any time:

```
mean[c]       = S[c] / W[c]
var[c]        = S2[c] / W[c] − mean[c]²
confidence[c] = W[c]           (evidence weight)
```

Defaults: cell size **0.2 m**, σ = **0.4 m**, R = **1.0 m** (2.5σ).

### Time decay

Multiply `W, S, S2` by `λ` per second, with half-life `h`: `λ = 0.5^(1/h)`. Default **h = 120 s**. Old evidence fades; re-walking a room updates it; the marker-test bloom visibly fades, which looks alive on screen.

### Sensor lag

Applied upstream in `voc_mapper`: each reading's pose is the pose at `t − lag`, so the sample is stamped where the wearer *was* when the air entered the sensor. `lag` is a single constant (default 12 s), calibrated by uncapping a marker at a known spot and timing the rise.

## Two implementations, same math

### A. Tiger Data (production path)

Hard 0.2 m bins instead of a Gaussian kernel; the smoothing is done at render time with a canvas blur. Visually equivalent at demo distance, and the DB owns the aggregation (good Tiger Data story).

```sql
-- continuous aggregate (see backend-architecture.md for DDL)
voc_cells(bucket 10 s, session, cx, cy, mean, sd, n)

-- /heatmap query with decay
SELECT cx, cy,
       sum(mean·n·w) / sum(n·w) AS mean,
       sum(n·w)                 AS weight
FROM (SELECT *, power(0.5, age_seconds(bucket)/half_life) AS w
      FROM voc_cells WHERE session=$1 AND bucket <= $until) t
GROUP BY cx, cy;
```

`until` makes the time scrubber free: the map "as of T" is the same query with `bucket <= T`.

Variance for the uncertainty toggle: `sum(n·w·(sd² + mean²))/sum(n·w) − mean_total²` (combining within-bucket and between-bucket variance). Good enough; don't over-engineer.

### B. In-browser (fast iteration / offline)

Straight implementation of the per-reading loop on `/voc_points`, in a `Float32Array` grid aligned to `/map`'s origin and resolution ×4. Use this on day 1 before the backend exists; keep it as a fallback.

## Rendering

| Channel | Encodes | Mapping |
|---|---|---|
| Colour | `mean` | LUT: transparent → teal → yellow → red, over `[0, 500]` (SGP40 index) or `[0, 300]` IAQ |
| Opacity | `confidence` | `min(1, W / W_ref)`, `W_ref` = the weight of ~3 close passes |
| Uncertainty view (toggle) | `sqrt(var)` | Greyscale, high = bright |

Draw each cell as a filled rect, then apply `filter: blur(6px)` on the heat canvas (not the map canvas). Composite the heat canvas over the occupancy grid with `globalCompositeOperation: 'screen'` on a dark background.

Never-visited cells are fully transparent — the map stays honest about what we didn't measure.

## Thresholds & alerting

| Level | SGP40 index | BME680 IAQ | Colour |
|---|---|---|---|
| Good | < 100 | < 50 | teal |
| Moderate | 100–250 | 50–150 | yellow |
| Poor | 250–400 | 150–250 | orange |
| Alert | > 400 | > 250 | red |

Alert fires when the **live reading** (not the cell mean) exceeds the Alert level for `HOLD_SECONDS` (5), with `COOLDOWN_SECONDS` (60). Uses live reading because the wearer's exposure is the point, not the room average.

## What to say in Q&A

> "The floor plan is a standard log-odds occupancy grid from slam_toolbox. The gas field is a kernel-weighted mean and variance per 20 cm cell — a lightweight stand-in for a Gaussian process, after Lilienthal's kernel DM+V — with a two-minute half-life so it tracks changing conditions. Opacity on the heat map is the evidence weight, so we never paint confidence we don't have. Sensor lag is corrected by placing each reading at the pose from twelve seconds earlier."

## Not doing

- Full Gaussian process regression (too slow at live rates, no time).
- Wind/advection modelling.
- 3D (2D LiDAR, single scan plane; say so if asked).
- Absolute concentrations in ppb — the SGP40 index is relative to a learned baseline; be upfront that this maps *relative* air quality.
