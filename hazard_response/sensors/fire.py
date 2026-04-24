from .base import SimulatedSensor


class SmokeSensor(SimulatedSensor):
    sensor_type = "smoke"
    unit = "ppm"


class TemperatureSensor(SimulatedSensor):
    sensor_type = "temperature"
    unit = "C"


class HumiditySensor(SimulatedSensor):
    sensor_type = "humidity"
    unit = "%"

    def read(self):
        # Humidity alerts on *low* values, so invert the spike direction.
        reading = super().read()
        if reading.metadata.get("simulated_spike"):
            return self._make_reading(
                max(0.0, self.baseline - abs(reading.value - self.baseline)),
                simulated_spike=True,
            )
        return reading
