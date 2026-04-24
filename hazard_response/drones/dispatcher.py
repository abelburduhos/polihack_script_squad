from __future__ import annotations

import math
import threading
from typing import Iterable, List, Optional, Tuple

from .drone import Drone, DroneStatus, MissionResult


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


class DroneDispatcher:
    """Picks the closest idle drone in range and sends it to a target.

    Safe to call ``dispatch`` from multiple threads — the pick + reservation
    happens atomically so two incidents never grab the same drone."""

    def __init__(self, drones: Iterable[Drone]):
        self.drones: List[Drone] = list(drones)
        self._lock = threading.Lock()

    def available(self) -> List[Drone]:
        return [d for d in self.drones if d.status == DroneStatus.IDLE]

    def _reserve(self, target: Tuple[float, float]) -> Optional[Drone]:
        with self._lock:
            candidates = [d for d in self.available() if d.can_reach(target)]
            if not candidates:
                return None
            drone = min(candidates, key=lambda d: _haversine_km(d.home, target))
            # Flip status inside the lock so no other thread can claim it.
            drone.status = DroneStatus.EN_ROUTE
            return drone

    def dispatch(self, target: Tuple[float, float]) -> Optional[MissionResult]:
        drone = self._reserve(target)
        if drone is None:
            return None
        # ``investigate`` will re-set EN_ROUTE (no-op) and run the mission.
        return drone.investigate(target)

    def add(self, drone: Drone) -> None:
        with self._lock:
            self.drones.append(drone)

    def remove(self, drone_id: str) -> bool:
        with self._lock:
            before = len(self.drones)
            self.drones = [d for d in self.drones if d.drone_id != drone_id]
            return len(self.drones) < before
