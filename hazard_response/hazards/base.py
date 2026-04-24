from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Dict, Iterable, List, Optional

from ..sensors.base import SensorReading


class Comparator(str, Enum):
    GT = ">"
    LT = "<"
    GTE = ">="
    LTE = "<="


@dataclass(frozen=True)
class AlertRule:
    """A single threshold rule against a sensor type."""

    sensor_type: str
    threshold: float
    comparator: Comparator = Comparator.GT
    severity_weight: float = 1.0

    def evaluate(self, reading: SensorReading) -> bool:
        if reading.sensor_type != self.sensor_type:
            return False
        v, t = reading.value, self.threshold
        return {
            Comparator.GT: v > t,
            Comparator.LT: v < t,
            Comparator.GTE: v >= t,
            Comparator.LTE: v <= t,
        }[self.comparator]


@dataclass
class HazardAlert:
    hazard_name: str
    triggering_readings: List[SensorReading]
    severity: float
    vision_prompt: str

    @property
    def location(self):
        # Average location of triggering sensors — drone flies to the cluster.
        lats = [r.location[0] for r in self.triggering_readings]
        lons = [r.location[1] for r in self.triggering_readings]
        return (sum(lats) / len(lats), sum(lons) / len(lons))


@dataclass
class HazardType:
    """A pluggable hazard definition. Extend the system by creating one of these
    and calling ``register_hazard``."""

    name: str
    rules: List[AlertRule]
    vision_prompt: str
    # How many rules must trigger at once before dispatching (default: 1).
    min_rules_to_trigger: int = 1
    # Optional custom severity calculation; defaults to summed weights.
    severity_fn: Optional[Callable[[List[SensorReading]], float]] = None

    def evaluate(self, readings: Iterable[SensorReading]) -> Optional[HazardAlert]:
        triggered: List[SensorReading] = []
        weight_sum = 0.0
        for reading in readings:
            for rule in self.rules:
                if rule.evaluate(reading):
                    triggered.append(reading)
                    weight_sum += rule.severity_weight
                    break
        if len(triggered) < self.min_rules_to_trigger:
            return None
        severity = (
            self.severity_fn(triggered) if self.severity_fn else weight_sum
        )
        return HazardAlert(
            hazard_name=self.name,
            triggering_readings=triggered,
            severity=severity,
            vision_prompt=self.vision_prompt,
        )


_REGISTRY: Dict[str, HazardType] = {}


def register_hazard(hazard: HazardType) -> None:
    if hazard.name in _REGISTRY:
        raise ValueError(f"Hazard '{hazard.name}' is already registered")
    _REGISTRY[hazard.name] = hazard


def get_hazard(name: str) -> HazardType:
    return _REGISTRY[name]


def list_hazards() -> List[HazardType]:
    return list(_REGISTRY.values())
