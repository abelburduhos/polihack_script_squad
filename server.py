"""FastAPI server: runs the monitor in a background thread and streams
sensor readings, drone status, and incidents to the browser via SSE.

Supports adding/removing sensors and drones at runtime — changes are
broadcast to every connected client as ``topology`` events."""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from hazard_response import (
    Drone,
    DroneDispatcher,
    HazardMonitor,
    VisionAnalyzer,
)
from hazard_response.hazards import list_hazards
from hazard_response.monitor import Incident
from hazard_response.sensors import (
    FlowRateSensor,
    HumiditySensor,
    RainfallSensor,
    SmokeSensor,
    TemperatureSensor,
    WaterLevelSensor,
)


log = logging.getLogger("server")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

TOWN_CENTER: Tuple[float, float] = (45.7489, 21.2087)
TICK_INTERVAL_S = 2.5
EVENT_BUFFER = 400


# ---------------------------------------------------------------------------
# Sensor factory — maps type name -> class + sensible defaults for quick add.
# ---------------------------------------------------------------------------
SENSOR_CLASSES = {
    "water_level": WaterLevelSensor,
    "rainfall":    RainfallSensor,
    "flow_rate":   FlowRateSensor,
    "smoke":       SmokeSensor,
    "temperature": TemperatureSensor,
    "humidity":    HumiditySensor,
}

SENSOR_DEFAULTS = {
    "water_level": dict(baseline=1.8, noise=0.3, spike_chance=0.15, spike_magnitude=2.5),
    "rainfall":    dict(baseline=5.0, noise=3.0, spike_chance=0.12, spike_magnitude=30.0),
    "flow_rate":   dict(baseline=40.0, noise=8.0, spike_chance=0.10, spike_magnitude=60.0),
    "smoke":       dict(baseline=60.0, noise=20.0, spike_chance=0.15, spike_magnitude=500.0),
    "temperature": dict(baseline=28.0, noise=3.0, spike_chance=0.15, spike_magnitude=25.0),
    "humidity":    dict(baseline=55.0, noise=5.0, spike_chance=0.15, spike_magnitude=45.0),
}


# ---------------------------------------------------------------------------
# Event bus — thread-safe fan-out to async subscribers.
# ---------------------------------------------------------------------------
class EventBus:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: List[asyncio.Queue] = []
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def publish(self, event: dict) -> None:
        with self._lock:
            subs = list(self._subscribers)
        if self._loop is None:
            return
        for q in subs:
            self._loop.call_soon_threadsafe(q.put_nowait, event)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)


bus = EventBus()


# ---------------------------------------------------------------------------
# World state
# ---------------------------------------------------------------------------
def on_drone_telemetry(drone: Drone) -> None:
    bus.publish({
        "type": "drone",
        "drone": serialize_drone(drone),
        "ts": time.time(),
    })


def _default_sensors():
    river = (TOWN_CENTER[0] - 0.03, TOWN_CENTER[1] + 0.02)
    forest = (TOWN_CENTER[0] + 0.01, TOWN_CENTER[1] + 0.08)
    return [
        WaterLevelSensor("river-01", river, **SENSOR_DEFAULTS["water_level"]),
        RainfallSensor("rain-01", river, **SENSOR_DEFAULTS["rainfall"]),
        FlowRateSensor("flow-01", river, **SENSOR_DEFAULTS["flow_rate"]),
        SmokeSensor("smoke-01", forest, **SENSOR_DEFAULTS["smoke"]),
        TemperatureSensor("temp-01", forest, **SENSOR_DEFAULTS["temperature"]),
        HumiditySensor("hum-01", forest, **SENSOR_DEFAULTS["humidity"]),
    ]


def _default_drones():
    return [
        Drone("drone-A", home=TOWN_CENTER, max_range_km=30.0,
              on_status_change=on_drone_telemetry),
        Drone("drone-B", home=(TOWN_CENTER[0] + 0.02, TOWN_CENTER[1]),
              max_range_km=30.0, on_status_change=on_drone_telemetry),
    ]


sensors = _default_sensors()
drones = _default_drones()

monitor = HazardMonitor(
    sensors=sensors,
    dispatcher=DroneDispatcher(drones),
    vision=VisionAnalyzer(),
)
# Keep the monitor's sensor list identical to ours (same list object).
monitor.sensors = sensors

# Lock held while mutating sensors/drones.
world_lock = threading.Lock()
# Incidents run concurrently so the tick loop doesn't block for ~20s each.
executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="incident")


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------
def serialize_reading(r) -> dict:
    return {
        "sensor_id": r.sensor_id,
        "sensor_type": r.sensor_type,
        "value": round(r.value, 2),
        "unit": r.unit,
        "location": list(r.location),
        "timestamp": r.timestamp.isoformat(),
    }


def serialize_sensor(s) -> dict:
    return {
        "sensor_id": s.sensor_id,
        "sensor_type": s.sensor_type,
        "unit": s.unit,
        "location": list(s.location),
    }


def serialize_drone(d: Drone) -> dict:
    return {
        "drone_id": d.drone_id,
        "home": list(d.home),
        "position": list(d.position),
        "status": d.status.value,
        "max_range_km": d.max_range_km,
    }


def serialize_incident(inc: Incident) -> dict:
    a = inc.alert
    return {
        "hazard_name": a.hazard_name,
        "severity": round(a.severity, 2),
        "location": list(a.location),
        "triggering_readings": [serialize_reading(r) for r in a.triggering_readings],
        "mission": {
            "drone_id": inc.mission.drone_id,
            "arrived": inc.mission.arrived,
            "notes": inc.mission.notes,
        } if inc.mission else None,
        "vision": {
            "threat_level": inc.vision.threat_level,
            "summary": inc.vision.summary,
        } if inc.vision else None,
    }


def serialize_hazard(h) -> dict:
    return {
        "name": h.name,
        "min_rules_to_trigger": h.min_rules_to_trigger,
        "rules": [
            {"sensor_type": r.sensor_type, "threshold": r.threshold,
             "comparator": r.comparator.value}
            for r in h.rules
        ],
    }


def publish_topology() -> None:
    bus.publish({
        "type": "topology",
        "sensors": [serialize_sensor(s) for s in sensors],
        "drones": [serialize_drone(d) for d in drones],
        "ts": time.time(),
    })


# ---------------------------------------------------------------------------
# Monitor loop — one tick every TICK_INTERVAL_S.
# ---------------------------------------------------------------------------
stop_event = threading.Event()


def _run_incident(alert):
    try:
        incident = monitor.handle(alert)
        bus.publish({
            "type": "incident",
            "incident": serialize_incident(incident),
            "ts": time.time(),
        })
    except Exception:
        log.exception("incident handler failed")


def monitor_loop():
    while not stop_event.is_set():
        try:
            readings = monitor.poll()
            bus.publish({
                "type": "tick",
                "readings": [serialize_reading(r) for r in readings],
                "drones": [serialize_drone(d) for d in drones],
                "ts": time.time(),
            })
            alerts = monitor.evaluate(readings)
            for alert in alerts:
                executor.submit(_run_incident, alert)
        except Exception:
            log.exception("monitor loop error")
        stop_event.wait(TICK_INTERVAL_S)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    bus.bind_loop(asyncio.get_running_loop())
    threading.Thread(target=monitor_loop, daemon=True, name="monitor").start()
    yield
    stop_event.set()
    executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Hazard Response", lifespan=lifespan)
STATIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def root():
    return FileResponse(STATIC / "index.html")


@app.get("/api/state")
async def state():
    return {
        "sensors": [serialize_sensor(s) for s in sensors],
        "drones": [serialize_drone(d) for d in drones],
        "hazards": [serialize_hazard(h) for h in list_hazards()],
        "town_center": list(TOWN_CENTER),
        "tick_interval_s": TICK_INTERVAL_S,
        "sensor_types": list(SENSOR_CLASSES.keys()),
    }


class SensorCreate(BaseModel):
    sensor_id: str = Field(min_length=1, max_length=40)
    sensor_type: str
    location: Tuple[float, float]
    baseline: Optional[float] = None
    noise: Optional[float] = None
    spike_chance: Optional[float] = None
    spike_magnitude: Optional[float] = None


@app.post("/api/sensors")
async def add_sensor(payload: SensorCreate):
    cls = SENSOR_CLASSES.get(payload.sensor_type)
    if not cls:
        raise HTTPException(400, f"unknown sensor_type '{payload.sensor_type}'")
    defaults = SENSOR_DEFAULTS[payload.sensor_type]
    kwargs = {
        "baseline": payload.baseline if payload.baseline is not None else defaults["baseline"],
        "noise": payload.noise if payload.noise is not None else defaults["noise"],
        "spike_chance": payload.spike_chance if payload.spike_chance is not None else defaults["spike_chance"],
        "spike_magnitude": payload.spike_magnitude if payload.spike_magnitude is not None else defaults["spike_magnitude"],
    }
    with world_lock:
        if any(s.sensor_id == payload.sensor_id for s in sensors):
            raise HTTPException(409, "sensor id already exists")
        sensor = cls(payload.sensor_id, tuple(payload.location), **kwargs)
        sensors.append(sensor)
    publish_topology()
    return serialize_sensor(sensor)


@app.delete("/api/sensors/{sensor_id}")
async def remove_sensor(sensor_id: str):
    with world_lock:
        ok = monitor.remove_sensor(sensor_id)
    if not ok:
        raise HTTPException(404, "sensor not found")
    publish_topology()
    return {"ok": True}


class DroneCreate(BaseModel):
    drone_id: str = Field(min_length=1, max_length=40)
    home: Tuple[float, float]
    max_range_km: float = Field(gt=0, le=500)
    cruise_speed_kmh: float = Field(default=60.0, gt=0, le=500)


@app.post("/api/drones")
async def add_drone(payload: DroneCreate):
    with world_lock:
        if any(d.drone_id == payload.drone_id for d in drones):
            raise HTTPException(409, "drone id already exists")
        drone = Drone(
            payload.drone_id,
            home=tuple(payload.home),
            max_range_km=payload.max_range_km,
            cruise_speed_kmh=payload.cruise_speed_kmh,
            on_status_change=on_drone_telemetry,
        )
        drones.append(drone)
        monitor.dispatcher.drones = drones
    publish_topology()
    return serialize_drone(drone)


@app.delete("/api/drones/{drone_id}")
async def remove_drone(drone_id: str):
    with world_lock:
        before = len(drones)
        drones[:] = [d for d in drones if d.drone_id != drone_id]
        monitor.dispatcher.drones = drones
        removed = len(drones) < before
    if not removed:
        raise HTTPException(404, "drone not found")
    publish_topology()
    return {"ok": True}


@app.get("/api/stream")
async def stream():
    q = bus.subscribe()

    async def gen():
        try:
            yield "retry: 2000\n\n"
            while True:
                event = await q.get()
                yield f"data: {json.dumps(event, default=str)}\n\n"
        except asyncio.CancelledError:
            raise
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
