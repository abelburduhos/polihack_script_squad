from __future__ import annotations

import random
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Tuple


@dataclass(frozen=True)
class SensorReading:
    sensor_id: str
    sensor_type: str
    value: float
    unit: str
    location: Tuple[float, float]
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict = field(default_factory=dict)


class Sensor(ABC):
    sensor_type: str = "generic"
    unit: str = ""

    def __init__(self, sensor_id: str, location: Tuple[float, float]):
        self.sensor_id = sensor_id
        self.location = location

    @abstractmethod
    def read(self) -> SensorReading: ...

    def _make_reading(self, value: float, **metadata) -> SensorReading:
        return SensorReading(
            sensor_id=self.sensor_id,
            sensor_type=self.sensor_type,
            value=value,
            unit=self.unit,
            location=self.location,
            metadata=metadata,
        )


class SimulatedSensor(Sensor):
    """Base for simulated sensors — generates values around a baseline with
    occasional spikes so the monitor has something to react to."""

    def __init__(
        self,
        sensor_id: str,
        location: Tuple[float, float],
        baseline: float,
        noise: float,
        spike_chance: float = 0.05,
        spike_magnitude: float = 5.0,
    ):
        super().__init__(sensor_id, location)
        self.baseline = baseline
        self.noise = noise
        self.spike_chance = spike_chance
        self.spike_magnitude = spike_magnitude

    def read(self) -> SensorReading:
        value = self.baseline + random.uniform(-self.noise, self.noise)
        spiking = random.random() < self.spike_chance
        if spiking:
            value += self.spike_magnitude * random.uniform(0.6, 1.4)
        return self._make_reading(value, simulated_spike=spiking)
