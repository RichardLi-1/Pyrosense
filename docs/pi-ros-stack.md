# Design: Pi ROS 2 stack

Everything that runs on the Raspberry Pi 5. This is the only ROS machine.

## Nodes

| Node | Package | Source | Subscribes | Publishes |
|---|---|---|---|---|
| `rplidar_node` | `rplidar_ros` | apt | USB `/dev/rplidar` | `/scan` (`sensor_msgs/LaserScan`) |
| `rf2o_laser_odometry_node` | `rf2o_laser_odometry` | git (MAPIRlab) | `/scan` | `/odom`, tf `odom→base_link` |
| `async_slam_toolbox_node` | `slam_toolbox` | apt | `/scan`, tf | `/map` (`OccupancyGrid`), `/pose` (`PoseWithCovarianceStamped`), tf `map→odom` |
| `voc_driver` | `voc_sensor` | ours | I²C | `/voc` (`voc_sensor/VocReading`) |
| `voc_mapper` | `voc_sensor` | ours | `/voc`, tf | `/voc_points` (`sensor_msgs/PointCloud2`) |
| `static_transform_publisher` ×2 | `tf2_ros` | apt | — | `/tf_static` |
| `foxglove_bridge` | `foxglove_bridge` | apt | all | WebSocket `:8765` |
| `ros2 bag record` | `rosbag2` | apt | selected topics | `.mcap` |

## Frame tree

```
map ──▶ odom ──▶ base_link ──▶ laser
                     └───────▶ voc_link
```

| Link | Owner | Nature |
|---|---|---|
| `map → odom` | slam_toolbox | Jumps on loop closure (drift correction) |
| `odom → base_link` | rf2o | Smooth, drifts |
| `base_link → laser` | static publisher | Measured with a ruler |
| `base_link → voc_link` | static publisher | Measured with a ruler |

`base_link` is the body origin: pick a point (e.g. centre of the chest mount at the LiDAR's height) and measure everything from it. Keep `z` for the laser at the real height; SLAM ignores it but it keeps the tree honest.

## Custom message

`voc_sensor/msg/VocReading.msg`

```
std_msgs/Header header       # stamp = time of the I2C read, frame_id = voc_link
float32 voc_index            # SGP40 index 0–500, or BME680 IAQ
float32 raw                  # raw resistance / ppb, sensor-specific
float32 temperature
float32 humidity
bool    warmed_up
```

## voc_driver

- Reads the chip at **2 Hz** (faster is pointless given sensor lag).
- Stamps with `self.get_clock().now()` *at the moment of the read*, before any processing.
- Publishes `warmed_up = False` for the first `WARMUP_SECONDS` (SGP40: 60 s, CCS811: 20 min — if CCS811, pre-warm before the demo).
- Uses the Adafruit CircuitPython library for the chip (`adafruit-circuitpython-sgp40`, `-bme680`, `-ccs811`) over `board.I2C()`.
- Logs one line per reading at `DEBUG`, one per 30 s at `INFO`.

## voc_mapper

For each `/voc` message:

1. Skip if `!warmed_up`.
2. `t_eff = header.stamp − SENSOR_LAG_SECONDS` (param, default 12.0).
3. `tf_buffer.lookup_transform('map', 'base_link', t_eff, timeout=0.2 s)`. On `ExtrapolationException` / `LookupException`, log once per 5 s and drop the reading.
4. Append `(x, y, 0, voc_index, t)` to an in-memory list, capped at 50 000 points (ring buffer). `t` is the `/voc` message's `header.stamp` in unix seconds.
5. Every 1 s (or every N new points), publish the whole list as a `PointCloud2` with fields `x, y, z, voc` (FLOAT32, offsets 0/4/8/12) and `t` (FLOAT64, offset 16), point_step 24, `frame_id = map`, `stamp = now`.

Also exposes a service `/voc_mapper/reset` (`std_srvs/Trigger`) to clear the buffer at the start of a session.

Rationale for publishing the full list each time rather than deltas: the backend's ingest worker treats each message as authoritative and de-dupes by the per-point `t` (a point is new iff its `t` is later than any seen) — simpler than reasoning about missed deltas over Wi‑Fi.

## Launch file: `wearable_bringup/launch/mapping.launch.py`

Starts, in order:

1. `static_transform_publisher` ×2 (args from `config/frames.yaml`)
2. `rplidar_node` (params from `config/rplidar_c1.yaml`)
3. `rf2o_laser_odometry_node` (params from `config/rf2o.yaml`)
4. `async_slam_toolbox_node` (params from `config/slam_toolbox.yaml`)
5. `voc_driver` (params from `config/voc.yaml`)
6. `voc_mapper` (params from `config/voc.yaml`)
7. `foxglove_bridge`
8. `ros2 bag record -o /data/bags/<session> /scan /tf /tf_static /voc /pose /map` as an `ExecuteProcess`

Launch argument `session:=<id>` is passed to `voc_driver` and used as the bag name. Launch argument `use_sim_time:=true` for replay.

## Config

`config/rplidar_c1.yaml`
```yaml
rplidar_node:
  ros__parameters:
    serial_port: /dev/rplidar
    serial_baudrate: 460800
    frame_id: laser
    angle_compensate: true
    scan_mode: Standard
```

`config/rf2o.yaml`
```yaml
rf2o_laser_odometry_node:
  ros__parameters:
    laser_scan_topic: /scan
    odom_topic: /odom
    publish_tf: true
    base_frame_id: base_link
    odom_frame_id: odom
    init_pose_from_topic: ""
    freq: 10.0
```

`config/slam_toolbox.yaml`
```yaml
slam_toolbox:
  ros__parameters:
    odom_frame: odom
    map_frame: map
    base_frame: base_link
    scan_topic: /scan
    mode: mapping
    use_scan_matching: true
    resolution: 0.05
    max_laser_range: 12.0
    minimum_time_interval: 0.2
    transform_timeout: 0.2
    map_update_interval: 1.0
    minimum_travel_distance: 0.2
    minimum_travel_heading: 0.2
    do_loop_closing: true
    loop_search_maximum_distance: 3.0
    loop_match_minimum_chain_size: 10
    loop_match_minimum_response_fine: 0.45
    scan_buffer_size: 10
    debug_logging: false
```

`config/frames.yaml` (used by the launch file to build the static publisher args)
```yaml
laser:     {x: 0.0, y: 0.0, z: 0.30, yaw: 0.0, pitch: 0.0, roll: 0.0}
voc_link:  {x: 0.05, y: 0.0, z: 0.25, yaw: 0.0, pitch: 0.0, roll: 0.0}
```

`config/voc.yaml`
```yaml
voc_driver:
  ros__parameters:
    chip: sgp40          # sgp40 | bme680 | ccs811
    rate_hz: 2.0
    warmup_seconds: 60.0
voc_mapper:
  ros__parameters:
    sensor_lag_seconds: 12.0
    publish_period_s: 1.0
    max_points: 50000
```

## Boot behaviour

`systemd` unit `wearable.service` runs `tmux new -d -s ros 'source /opt/ros/jazzy/setup.bash && source ~/ros2_ws/install/setup.bash && ros2 launch wearable_bringup mapping.launch.py session:=auto'` on boot. `session:=auto` → `hostname + ISO timestamp`. Anyone can `tmux attach -t ros`.

Udev rule for the LiDAR (`/etc/udev/rules.d/rplidar.rules`):
```
KERNEL=="ttyUSB*", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", MODE:="0666", SYMLINK+="rplidar"
```

## Install checklist

```
sudo apt install ros-jazzy-ros-base ros-jazzy-slam-toolbox ros-jazzy-rplidar-ros \
                 ros-jazzy-foxglove-bridge ros-jazzy-tf2-tools ros-jazzy-rosbag2-storage-mcap \
                 python3-pip chrony tmux
pip install --break-system-packages adafruit-circuitpython-sgp40 adafruit-blinka
cd ~/ros2_ws/src && git clone https://github.com/MAPIRlab/rf2o_laser_odometry
cd ~/ros2_ws && colcon build --symlink-install
sudo usermod -aG dialout,i2c $USER
```

Enable I²C: `sudo raspi-config` → Interface Options → I2C (or add `dtparam=i2c_arm=on` to `/boot/firmware/config.txt`).

## Debugging

| Symptom | Check |
|---|---|
| No `/scan` | `ls -l /dev/rplidar`; `ros2 topic hz /scan`; dialout group; baud rate |
| "Could not transform laser → map" | `ros2 run tf2_tools view_frames`; frame names in configs match; static publishers running |
| "Extrapolation into the future" | Clocks: `chronyc tracking`; `transform_timeout` |
| Map shears / hallways don't meet | Walk slower; turn slower; raise `loop_search_maximum_distance`; consider IMU |
| `/voc_points` empty | `warmed_up` false? tf lookup failing (lag too large for buffer)? Check mapper log |
| Foxglove can't connect | `ss -ltnp | grep 8765`; firewall; Pi IP |

## Replay

```
ros2 launch wearable_bringup mapping.launch.py use_sim_time:=true replay:=true
ros2 bag play /data/bags/<session> --clock
```
`replay:=true` skips the driver nodes and the bag recorder. Downstream is identical.
