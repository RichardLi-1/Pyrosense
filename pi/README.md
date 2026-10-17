# Pi 5 ROS 2 stack

Everything that runs on the wearer's Raspberry Pi. Design: `docs/pi-ros-stack.md`.

```
pi/src/
  voc_msgs/          VocReading.msg
  voc_sensor/        voc_driver (SGP30 over I2C, /voc)  ·  voc_mapper (/voc + tf -> /voc_points)
  wearable_bringup/  mapping.launch.py · config/*.yaml · systemd/wearable.service
```

## Build

```bash
# once: link this folder into the colcon workspace
ln -s ~/firefighter-hazard/pi/src ~/ros2_ws/src/hazard
cd ~/ros2_ws && colcon build --symlink-install && source install/setup.bash
```

## Run

```bash
ros2 launch wearable_bringup mapping.launch.py session:=utsc-sw-14h      # live
ros2 launch wearable_bringup mapping.launch.py chip:=fake record:=false  # no VOC hardware
ros2 launch wearable_bringup mapping.launch.py replay:=true use_sim_time:=true
ros2 bag play /data/bags/<session> --clock                               # in another pane
```

Fake VOC spike for testing: `touch /tmp/voc_spike` (remove the file to end it).

Reset the point buffer at the start of a walk: `ros2 service call /voc_mapper/reset std_srvs/srv/Trigger`.

## Sensor

The chip on the board is an **SGP30** (I2C 0x58): it reports **TVOC in ppb** (not the SGP40 0-500 index).
`VocReading.unit` is `"ppb"`. Rough bands: <220 good · 220-660 moderate · 660-2200 poor · >2200 alert.
The backend's `VOC_THRESHOLD` and the dashboard colour scale must use this scale.

## Checks

| What | Command |
|---|---|
| LiDAR | `ros2 topic hz /scan` (10 Hz) |
| Odometry tf | `ros2 run tf2_ros tf2_echo odom base_link` |
| SLAM | `ros2 topic hz /map` · `ros2 topic echo /pose --once` |
| VOC | `ros2 topic echo /voc --once` |
| Points | `ros2 topic echo /voc_points --once --no-arr` |
| Bridge | `ss -ltnp \| grep 8765`, Foxglove Studio -> `ws://<pi>:8765` |
| Frames | `ros2 run tf2_tools view_frames` |

## Boot

`systemd/wearable.service` starts the stack in a tmux session named `ros` at boot. `tmux attach -t ros`.
