from __future__ import annotations

import math
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Tuple


class DroneStatus(str, Enum):
    IDLE = "idle"
    EN_ROUTE = "en_route"
    ON_SITE = "on_site"
    RETURNING = "returning"
    CHARGING = "charging"


@dataclass
class MissionResult:
    drone_id: str
    target: Tuple[float, float]
    image_path: Optional[str]
    arrived: bool
    notes: str = ""


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


class Drone:
    """Represents a single drone. Flight is simulated — plug a real SDK
    (e.g. DJI, MAVLink/Dronekit) into ``_fly_to`` and ``_capture_image``."""

    def __init__(
        self,
        drone_id: str,
        home: Tuple[float, float],
        max_range_km: float = 25.0,
        cruise_speed_kmh: float = 60.0,
        image_provider=None,
        on_status_change=None,
    ):
        self.drone_id = drone_id
        self.home = home
        self.position = home
        self.max_range_km = max_range_km
        self.cruise_speed_kmh = cruise_speed_kmh
        self._status = DroneStatus.IDLE
        # image_provider(target) -> path. Lets tests / real hardware swap in.
        self._image_provider = image_provider or (lambda _t: None)
        self._on_status_change = on_status_change

    @property
    def status(self) -> DroneStatus:
        return self._status

    @status.setter
    def status(self, value: DroneStatus) -> None:
        self._status = value
        if self._on_status_change:
            try:
                self._on_status_change(self)
            except Exception:
                pass

    def can_reach(self, target: Tuple[float, float]) -> bool:
        # Must be able to fly there *and* back.
        return _haversine_km(self.home, target) * 2 <= self.max_range_km

    def investigate(self, target: Tuple[float, float]) -> MissionResult:
        if not self.can_reach(target):
            return MissionResult(self.drone_id, target, None, False, "out of range")

        self.status = DroneStatus.EN_ROUTE
        self._fly_to(target)
        self.status = DroneStatus.ON_SITE
        image_path = self._capture_image(target)
        time.sleep(2.0)  # survey dwell time
        self.status = DroneStatus.RETURNING
        self._fly_to(self.home)
        self.status = DroneStatus.IDLE
        return MissionResult(self.drone_id, target, image_path, True)

    # How fast sim time runs vs. real — lower = more watchable.
    SIM_SPEEDUP = 40.0
    FLIGHT_MIN_S = 4.0
    FLIGHT_MAX_S = 14.0
    STEP_S = 0.4

    def _fly_to(self, target: Tuple[float, float]) -> None:
        """Linearly interpolate from current position to target, publishing
        telemetry every STEP_S so the UI sees a smooth glide."""
        start = self.position
        km = _haversine_km(start, target)
        real_seconds = km / self.cruise_speed_kmh * 3600
        flight_s = max(self.FLIGHT_MIN_S,
                       min(self.FLIGHT_MAX_S, real_seconds / self.SIM_SPEEDUP))
        steps = max(1, int(flight_s / self.STEP_S))
        for i in range(1, steps + 1):
            t = i / steps
            self.position = (
                start[0] + (target[0] - start[0]) * t,
                start[1] + (target[1] - start[1]) * t,
            )
            self._notify()
            time.sleep(self.STEP_S)
        self.position = target
        self._notify()

    def _notify(self) -> None:
        if self._on_status_change:
            try:
                self._on_status_change(self)
            except Exception:
                pass

    def _capture_image(self, target: Tuple[float, float]) -> Optional[str]:
        return self._image_provider(target)
