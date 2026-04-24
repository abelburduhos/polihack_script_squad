"""Demo runner for hazard_response.

Simulates a ring of sensors near a town, registers flash-flood and wildfire
hazards (already done by importing the package), and runs the monitor for a
few ticks. With no ANTHROPIC_API_KEY set, the vision step returns a stub so
the end-to-end flow is still observable.
"""
from __future__ import annotations

import logging
import random
import time

from hazard_response import (
    Drone,
    DroneDispatcher,
    HazardMonitor,
    VisionAnalyzer,
)
from hazard_response.sensors import (
    FlowRateSensor,
    HumiditySensor,
    RainfallSensor,
    SmokeSensor,
    TemperatureSensor,
    WaterLevelSensor,
)
from hazard_response.monitor import Incident


TOWN_CENTER = (45.7489, 21.2087)  # Timișoara, RO


def build_sensors():
    # Flood: riverbanks to the south
    river = (TOWN_CENTER[0] - 0.03, TOWN_CENTER[1] + 0.02)
    # Fire: dry forest to the east
    forest = (TOWN_CENTER[0] + 0.01, TOWN_CENTER[1] + 0.08)

    return [
        WaterLevelSensor("river-01", river, baseline=1.8, noise=0.3,
                         spike_chance=0.25, spike_magnitude=2.5),
        RainfallSensor("rain-01", river, baseline=5.0, noise=3.0,
                       spike_chance=0.20, spike_magnitude=30.0),
        FlowRateSensor("flow-01", river, baseline=40.0, noise=8.0,
                       spike_chance=0.15, spike_magnitude=60.0),
        SmokeSensor("smoke-01", forest, baseline=60.0, noise=20.0,
                    spike_chance=0.25, spike_magnitude=500.0),
        TemperatureSensor("temp-01", forest, baseline=28.0, noise=3.0,
                          spike_chance=0.25, spike_magnitude=25.0),
        HumiditySensor("hum-01", forest, baseline=55.0, noise=5.0,
                       spike_chance=0.25, spike_magnitude=45.0),
    ]


def build_drones():
    return [
        Drone("drone-A", home=TOWN_CENTER, max_range_km=30.0),
        Drone("drone-B", home=(TOWN_CENTER[0] + 0.02, TOWN_CENTER[1]),
              max_range_km=30.0),
    ]


def print_incident(incident: Incident) -> None:
    a = incident.alert
    print(f"\n=== INCIDENT: {a.hazard_name.upper()} ===")
    print(f"  severity: {a.severity:.1f}  location: {a.location}")
    for r in a.triggering_readings:
        print(f"  - {r.sensor_id} {r.sensor_type}={r.value:.1f}{r.unit}")
    if incident.mission:
        print(f"  drone {incident.mission.drone_id} "
              f"{'arrived' if incident.mission.arrived else 'failed'}")
    else:
        print("  NO DRONE AVAILABLE")
    if incident.vision:
        v = incident.vision
        print(f"  vision threat={v.threat_level}: {v.summary}")


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    random.seed(42)

    monitor = HazardMonitor(
        sensors=build_sensors(),
        dispatcher=DroneDispatcher(build_drones()),
        vision=VisionAnalyzer(),
        on_incident=print_incident,
    )

    for tick in range(5):
        print(f"\n--- tick {tick + 1} ---")
        incidents = monitor.tick()
        if not incidents:
            print("  all clear")
        time.sleep(0.2)


if __name__ == "__main__":
    main()
