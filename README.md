![PyroSense dashboard](resources/Screenshot%202026-11-22%20at%208.09.54%E2%80%AFPM.png)

<video src="resources/1018%281%29.mp4" controls width="100%"></video>

[▶ Watch the demo](resources/1018%281%29.mp4)

# PyroSense

Wearable LiDAR + gas sensing that maps indoor hazards as a firefighter moves through a building.

<img width="100%" alt="PyroSense project overview" src="https://github.com/user-attachments/assets/b1b20dbf-de46-4002-b1df-1fe84f21ab0f" />

- **Map live:** build a floor plan and track the wearer's path.
- **See hazards:** overlay VOC readings, heatmaps, and alerts.
- **Review later:** save sessions and replay readings over time.

**Hardware:** Raspberry Pi 5 · RPLIDAR C1 · SGP30 VOC sensor · helmet-mounted rig.

**Stack:** ROS 2 → Foxglove bridge → FastAPI → React dashboard, with PostgreSQL + TimescaleDB for history.

## Build & run

[Pi setup](pi/README.md) · [Backend & local demo](backend/README.md) · [Dashboard](docs/dashboard.md)

[Architecture](docs/ARCHITECTURE.md) · [ROS messages](docs/ros-messages.md) · [Gas mapping](docs/voc-mapping.md)

**Team:** Tyler · Justin · Richard · Jessica
