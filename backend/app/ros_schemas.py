"""ROS 2 message definitions in the concatenated "ros2msg" form foxglove_bridge
advertises. Used by the fake Pi server and by tests; the live client always
uses the schema text the bridge sends.
"""

_SEP = "=" * 80

HEADER_DEPS = f"""{_SEP}
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
{_SEP}
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""

POSE_DEPS = f"""{_SEP}
MSG: geometry_msgs/Pose
geometry_msgs/Point position
geometry_msgs/Quaternion orientation
{_SEP}
MSG: geometry_msgs/Point
float64 x
float64 y
float64 z
{_SEP}
MSG: geometry_msgs/Quaternion
float64 x
float64 y
float64 z
float64 w
"""

POSE_WITH_COV_STAMPED = f"""std_msgs/Header header
geometry_msgs/PoseWithCovariance pose
{HEADER_DEPS}{_SEP}
MSG: geometry_msgs/PoseWithCovariance
geometry_msgs/Pose pose
float64[36] covariance
{POSE_DEPS}"""

POINT_CLOUD2 = f"""std_msgs/Header header
uint32 height
uint32 width
sensor_msgs/PointField[] fields
bool is_bigendian
uint32 point_step
uint32 row_step
uint8[] data
bool is_dense
{HEADER_DEPS}{_SEP}
MSG: sensor_msgs/PointField
uint8 INT8=1
uint8 UINT8=2
uint8 INT16=3
uint8 UINT16=4
uint8 INT32=5
uint8 UINT32=6
uint8 FLOAT32=7
uint8 FLOAT64=8
string name
uint32 offset
uint8 datatype
uint32 count
"""

OCCUPANCY_GRID = f"""std_msgs/Header header
nav_msgs/MapMetaData info
int8[] data
{HEADER_DEPS}{_SEP}
MSG: nav_msgs/MapMetaData
builtin_interfaces/Time map_load_time
float32 resolution
uint32 width
uint32 height
geometry_msgs/Pose origin
{POSE_DEPS}"""

VOC_READING = f"""std_msgs/Header header
float32 voc
string unit
float32 eco2
float32 raw_h2
float32 raw_ethanol
float32 temperature
float32 humidity
bool warmed_up
{HEADER_DEPS}"""

SCHEMAS = {
    "voc_msgs/msg/VocReading": VOC_READING,
    "geometry_msgs/msg/PoseWithCovarianceStamped": POSE_WITH_COV_STAMPED,
    "sensor_msgs/msg/PointCloud2": POINT_CLOUD2,
    "nav_msgs/msg/OccupancyGrid": OCCUPANCY_GRID,
}
