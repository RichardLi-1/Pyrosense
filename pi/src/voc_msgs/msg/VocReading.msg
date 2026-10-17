# One VOC sample. header.stamp = time of the I2C read, header.frame_id = voc_link.
std_msgs/Header header
float32 voc            # concentration in `unit` (SGP30: TVOC ppb; SGP40: VOC index 0-500)
string  unit           # "ppb" | "index"
float32 eco2           # equivalent CO2, ppm (SGP30 only, else 0)
float32 raw_h2         # raw H2 signal (SGP30), 0 otherwise
float32 raw_ethanol    # raw ethanol signal (SGP30), 0 otherwise
float32 temperature    # degC if a T/RH sensor is present, else NaN
float32 humidity       # %RH if present, else NaN
bool    warmed_up      # false during sensor warm-up; voc_mapper drops these
