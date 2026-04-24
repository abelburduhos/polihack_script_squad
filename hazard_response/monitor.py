from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional

from .drones import DroneDispatcher, MissionResult
from .hazards import HazardAlert, HazardType, list_hazards
from .sensors import Sensor, SensorReading
from .vision import VisionAnalyzer, VisionReport


log = logging.getLogger("hazard_response")


@dataclass
class Incident:
    alert: HazardAlert
    mission: Optional[MissionResult]
    vision: Optional[VisionReport]

    @property
    def confirmed(self) -> bool:
        return bool(self.vision and self.vision.threat_level >= 4)


class HazardMonitor:
    """Ties sensors, hazards, drones, and vision together.

    A single ``tick()`` polls every sensor, evaluates every registered hazard,
    and dispatches a drone for each triggered hazard. Keep the monitor small —
    new hazards are added via ``register_hazard`` in their own module, and new
    sensor types plug in by subclassing ``Sensor``."""

    def __init__(
        self,
        sensors: Iterable[Sensor],
        dispatcher: DroneDispatcher,
        vision: VisionAnalyzer,
        hazards: Optional[Iterable[HazardType]] = None,
        on_incident: Optional[Callable[[Incident], None]] = None,
    ):
        self.sensors: List[Sensor] = list(sensors)
        self.dispatcher = dispatcher
        self.vision = vision
        self.hazards: List[HazardType] = list(hazards) if hazards else list(list_hazards())
        self.on_incident = on_incident

    def poll(self) -> List[SensorReading]:
        readings: List[SensorReading] = []
        for sensor in list(self.sensors):  # snapshot: mutation-safe
            try:
                readings.append(sensor.read())
            except Exception:
                log.exception("sensor %s failed to read", sensor.sensor_id)
        return readings

    def add_sensor(self, sensor: Sensor) -> None:
        self.sensors.append(sensor)

    def remove_sensor(self, sensor_id: str) -> bool:
        before = len(self.sensors)
        self.sensors = [s for s in self.sensors if s.sensor_id != sensor_id]
        return len(self.sensors) < before

    def evaluate(self, readings: List[SensorReading]) -> List[HazardAlert]:
        alerts: List[HazardAlert] = []
        for hazard in self.hazards:
            alert = hazard.evaluate(readings)
            if alert is not None:
                alerts.append(alert)
        return alerts

    def handle(self, alert: HazardAlert) -> Incident:
        log.warning(
            "alert %s severity=%.1f @ %s",
            alert.hazard_name, alert.severity, alert.location,
        )
        mission = self.dispatcher.dispatch(alert.location)
        if mission is None:
            log.error("no drone available for %s", alert.hazard_name)
            incident = Incident(alert=alert, mission=None, vision=None)
        else:
            report = self.vision.analyze(
                image_path=mission.image_path,
                hazard_name=alert.hazard_name,
                vision_prompt=alert.vision_prompt,
            )
            incident = Incident(alert=alert, mission=mission, vision=report)
        if self.on_incident:
            self.on_incident(incident)
        return incident

    def tick(self) -> List[Incident]:
        readings = self.poll()
        alerts = self.evaluate(readings)
        return [self.handle(a) for a in alerts]
