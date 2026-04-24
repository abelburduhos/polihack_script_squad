from .base import SimulatedSensor


class WaterLevelSensor(SimulatedSensor):
    sensor_type = "water_level"
    unit = "m"


class RainfallSensor(SimulatedSensor):
    sensor_type = "rainfall"
    unit = "mm/h"


class FlowRateSensor(SimulatedSensor):
    sensor_type = "flow_rate"
    unit = "m^3/s"
