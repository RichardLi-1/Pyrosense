# ROS Message Reference

What each topic on the Pi looks like on the wire, with one decoded example each. For the overall data flow, see [ARCHITECTURE.md](ARCHITECTURE.md).

| Topic | Type | Rate | Published by |
|---|---|---|---|
| `/scan` | `sensor_msgs/LaserScan` | 10 Hz | `rplidar_ros` |
| `/tf` | `tf2_msgs/TFMessage` | ~10–30 Hz | `rf2o` (odom → base_link), `slam_toolbox` (map → odom) |
| `/map` | `nav_msgs/OccupancyGrid` | every ~5 s | `slam_toolbox` |
| `/voc` | `voc_msgs/VocReading` (custom) | ~1 Hz | `gas_node` |
| `/wearer_pose` | `geometry_msgs/PoseStamped` | ~5 Hz | `fusion_node` |
| `/voc_points` | `sensor_msgs/PointCloud2` | ~1 Hz | `fusion_node`. **This is the Pi → backend contract.** |

---

## `/scan`: `sensor_msgs/LaserScan`

One message = one full revolution. Each entry in `ranges[]` is one reading, and its angle is implied by its index.

```yaml
header:
  stamp: {sec: 1760670000, nanosec: 412000000}
  frame_id: laser
angle_min: -3.1416
angle_max:  3.1416
angle_increment: 0.01257        # 0.72° → ~500 readings/rev on a C1
time_increment: 0.0002
scan_time: 0.1                  # 10 Hz
range_min: 0.05
range_max: 12.0
ranges: [2.31, 2.33, 2.36, inf, inf, 0.84, 0.85, ...]   # ~500 floats, metres
intensities: [47, 49, 52, 0, 0, 180, 182, ...]           # reflectivity
```

Decoding index 5: angle = −3.1416 + 5 × 0.01257 = −3.079 rad, distance 0.84 m, giving x = 0.84·cos(angle) ≈ −0.84 and y = 0.84·sin(angle) ≈ −0.05. That's a point ~84 cm behind the sensor. `inf` means no return.

---

## `/tf`: `tf2_msgs/TFMessage`

Each message carries one or more transforms. The chain that answers "where is the person" is **`map → odom → base_link`**:

- **`odom → base_link`** comes from `rf2o` (laser odometry: motion estimated from consecutive scans). It's smooth but drifts.
- **`map → odom`** comes from `slam_toolbox`. It's the correction for that drift.

```yaml
transforms:
  - header: {stamp: {sec: 1760670000, nanosec: 412000000}, frame_id: map}
    child_frame_id: odom
    transform:
      translation: {x: 0.12, y: -0.04, z: 0.0}                 # metres
      rotation:    {x: 0.0, y: 0.0, z: 0.0087, w: 0.99996}     # ≈ 1° yaw
```

If `rf2o` says `odom → base_link` = (4.21, −1.07) at 31°, tf2 combines the two as **map → base_link ≈ (4.35, −1.04) at 32°**. That is the wearer's position and heading. Note it is not simply the sum of the two translations, because the 1° rotation applies first.

Quaternion to heading (2D): `yaw = 2·atan2(z, w)`. For example, (z = 0.267, w = 0.964) gives ≈ 0.54 rad ≈ 31°.

`fusion_node` does this lookup and republishes the result as `/wearer_pose`, so the backend never has to handle `/tf`.

---

## `/map`: `nav_msgs/OccupancyGrid`

```yaml
header: {stamp: ..., frame_id: map}
info:
  resolution: 0.05               # metres per cell
  width:  400                    # cells → 20 m
  height: 300                    # cells → 15 m
  origin:                        # map-frame position of cell (0,0)'s corner
    position: {x: -10.0, y: -7.5, z: 0.0}
    orientation: {x: 0, y: 0, z: 0, w: 1}
data: [-1, -1, -1, 0, 0, 0, 100, 100, -1, ...]   # 120,000 int8s, row-major
```

- Cell values: −1 = unknown, 0 = free, 100 = occupied. `slam_toolbox` also emits 1–99 near edges.
- Cell (col, row) is at `data[row × width + col]`.
- Its world centre is `x = origin.x + (col + 0.5) × resolution`, and the same for y.

Example: `data[153 × 400 + 284] = 100` means a wall at (−10 + 284.5 × 0.05, −7.5 + 153.5 × 0.05) = **(4.23, 0.18)**.

---

## `/voc`: `voc_msgs/VocReading` (custom)

```yaml
header: {stamp: {sec: 1760670000, nanosec: 412000000}, frame_id: voc_link}
voc: 183.0             # TVOC in `unit`
unit: ppb              # SGP30 reports ppb; "index" if an SGP40 is ever used
eco2: 412.0            # equivalent CO2, ppm
raw_h2: 13119.0
raw_ethanol: 18472.0
temperature: 22.4      # NaN without a T/RH sensor
humidity: 41.0
warmed_up: true        # SGP30 returns 0 ppb / 400 ppm during its ~15 s init
```

`fusion_node` looks up the pose at this message's `stamp`, so each reading is placed where the wearer was when it was taken.

---

## `/voc_points`: `sensor_msgs/PointCloud2` (the contract)

Gas readings placed on the map, packed as binary. The backend reads it for the heatmap, alerts and storage. RViz/Foxglove can color the points by `voc`. Don't change the field layout without telling the backend and dashboard owners.

A message may carry only the newest reading or every reading so far. Each point's `t` (unix seconds) is what lets the backend tell a new reading from a re-sent one: it only processes points with a later `t` than any it has seen. Without `t` it falls back to guessing, which drops repeated identical readings (see [ARCHITECTURE.md §4.1](ARCHITECTURE.md#41-pi--backend-the-hard-boundary)).

```yaml
header: {stamp: ..., frame_id: map}
height: 1
width: 1842                      # points so far
fields:
  - {name: x,   offset: 0,  datatype: 7, count: 1}   # 7 = FLOAT32
  - {name: y,   offset: 4,  datatype: 7, count: 1}
  - {name: z,   offset: 8,  datatype: 7, count: 1}
  - {name: voc, offset: 12, datatype: 7, count: 1}
  - {name: t,   offset: 16, datatype: 8, count: 1}   # 8 = FLOAT64, reading time (unix s)
point_step: 24                   # bytes per point
row_step: 44208                  # 1842 × 24
is_dense: true
data: <44,208 bytes>
```

Decoded point: x = 4.35, y = −1.04, z = 0.0, voc = 183.0, t = 1760670000.412.

- On the Pi: read it with `sensor_msgs_py.point_cloud2.read_points()`.
- On the laptop (no ROS): rosbridge sends `data` as base64. Use `np.frombuffer(b64decode(data), dtype="<f4").reshape(-1, 4)`.
