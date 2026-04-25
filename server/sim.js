// Simulation: signal stations + individual sensors, alarm lifecycle, weather eval.

const db      = require("./db");
const config  = require("./config");
const weather = require("./weather");

const state = {
  stations: new Map(),  // stationId  → station
  sensors:  new Map(),  // sensorId   → sensor
  alarms:   new Map(),  // alarmId    → alarm
  clients:  new Set(),
  stationCounter: 0,
  sensorCounter:  0,
};

// ----- WS plumbing -----
function broadcast(msg) {
  const p = JSON.stringify(msg);
  for (const ws of state.clients) if (ws.readyState === 1) ws.send(p);
}
function attachClient(ws) { state.clients.add(ws); }
function detachClient(ws) { state.clients.delete(ws); }

// ----- Logging -----
function logEvent(message, kind = "info") {
  broadcast({ type: "log", message, kind, time: new Date().toISOString() });
  db.query("INSERT INTO events (kind, message) VALUES ($1, $2)", [kind, message])
    .catch((err) => console.error("[log]", err.message));
}

// ----- Snapshots -----
function snapStation(s) {
  return { id: s.id, name: s.name, lat: s.lat, lng: s.lng, rangeM: s.rangeM, createdAt: s.createdAt };
}
function snapSensor(s) {
  return {
    id: s.id, stationId: s.stationId, type: s.type,
    lat: s.lat, lng: s.lng, battery: s.battery,
    metrics: s.metrics, alarmActive: s.alarmActive,
    lastUpdate: s.lastUpdate,
    detectionRadiusM: detectionRadiusFor(s.type),
    commRangeM: s.commRangeM ?? commRangeFor(s.type),
  };
}
function snapAlarm(a) {
  return {
    id: a.id, sensorId: a.sensorId, type: a.type,
    ts: a.ts, verdict: a.verdict, weatherReason: a.weatherReason,
  };
}
function buildSnapshot() {
  return {
    stations: [...state.stations.values()].map(snapStation),
    sensors:  [...state.sensors.values()].map(snapSensor),
    alarms:   [...state.alarms.values()].map(snapAlarm),
  };
}

// ----- Helpers -----
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const rnd    = (lo, hi) => lo + Math.random() * (hi - lo);

function detectionRadiusFor(type) {
  return type === "wildfire"
    ? config.wildfireSensor.detectionRadiusMeters
    : config.floodSensor.detectionRadiusMeters;
}
function commRangeFor(type) {
  return type === "wildfire"
    ? config.wildfireSensor.commRangeMeters
    : config.floodSensor.commRangeMeters;
}
function readingIntervalFor(type) {
  return type === "wildfire"
    ? config.wildfireSensor.readingIntervalMs
    : config.floodSensor.readingIntervalMs;
}
function batteryDrainFor(type) {
  return type === "wildfire"
    ? config.wildfireSensor.battery.drainPerReading
    : config.floodSensor.battery.drainPerReading;
}

// ----- Reading generation (random walk) -----
function nextReading(type, prev) {
  if (type === "wildfire") {
    const p = prev || { co2_ppm: 410, temp_c: 14, humidity_pct: 58, smoke_index: 0.04 };
    return {
      co2_ppm:      Math.round(clamp(p.co2_ppm      + rnd(-4, 4),    380, 900)),
      temp_c:       round1(clamp(p.temp_c       + rnd(-0.3, 0.3),  -10, 45)),
      humidity_pct: round1(clamp(p.humidity_pct + rnd(-1.2, 1.2),    5, 100)),
      smoke_index:  round2(clamp(p.smoke_index  + rnd(-0.02, 0.02),  0, 1)),
    };
  }
  const p = prev || { level_cm: 80, flow_m3s: 25, temp_c: 12, turbidity_ntu: 8 };
  return {
    level_cm:      round1(clamp(p.level_cm      + rnd(-1.2, 1.2),   0, 1500)),
    flow_m3s:      round1(clamp(p.flow_m3s      + rnd(-0.6, 0.6),   0, 5000)),
    temp_c:        round1(clamp(p.temp_c        + rnd(-0.2, 0.2),   0, 30)),
    turbidity_ntu: round1(clamp(p.turbidity_ntu + rnd(-0.5, 0.5),   0, 1000)),
  };
}

// ----- Alarm detection -----
function checkAlarm(type, metrics) {
  if (type === "wildfire") {
    const t = config.wildfireSensor.alarmThresholds;
    return (
      (metrics.smoke_index > t.smokeIndex &&
        (metrics.temp_c > t.tempC || metrics.humidity_pct < t.humidityPct)) ||
      metrics.co2_ppm > t.co2Ppm
    );
  }
  const t = config.floodSensor.alarmThresholds;
  return metrics.level_cm > t.levelCm || metrics.flow_m3s > t.flowM3s;
}

// ----- Alarm lifecycle -----
async function fireAlarm(sensor, metrics) {
  if (sensor.alarmActive) return;
  sensor.alarmActive = true;
  await db.query("UPDATE sensors SET alarm_active = TRUE WHERE id = $1", [sensor.id]);

  const ins = await db.query(
    `INSERT INTO alarms (sensor_id, type, metrics_snapshot, verdict)
     VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id, ts`,
    [sensor.id, sensor.type, JSON.stringify(metrics)]
  );
  const alarm = {
    id: ins.rows[0].id, sensorId: sensor.id, type: sensor.type,
    ts: ins.rows[0].ts, verdict: "pending", weatherReason: null,
  };
  state.alarms.set(alarm.id, alarm);
  broadcast({ type: "alarm:new", alarm: snapAlarm(alarm) });
  logEvent(`⚠ Alarm: ${sensor.id} (${sensor.type}) — evaluating with weather data…`, "alarm");

  setTimeout(() => resolveAlarm(alarm.id, sensor).catch(console.error), 5000);
}

async function resolveAlarm(alarmId, sensor) {
  const alarm = state.alarms.get(alarmId);
  if (!alarm || alarm.verdict !== "pending") return;

  const ev = await weather.evaluateAlarm(sensor.type, sensor.lat, sensor.lng);
  const verdict = ev.confirmed === null ? "real" : ev.confirmed ? "real" : "false_alarm";

  alarm.verdict = verdict;
  alarm.weatherReason = ev.reason;

  await db.query(
    `UPDATE alarms SET verdict = $1, weather_data = $2::jsonb, weather_reason = $3 WHERE id = $4`,
    [verdict, JSON.stringify(ev.weather), ev.reason, alarmId]
  );

  if (verdict === "false_alarm") {
    sensor.alarmActive = false;
    await db.query("UPDATE sensors SET alarm_active = FALSE WHERE id = $1", [sensor.id]);
  }

  broadcast({ type: "alarm:verdict", alarm: snapAlarm(alarm) });
  logEvent(
    verdict === "real"
      ? `🔴 REAL: ${sensor.id} — ${ev.reason}`
      : `✅ False alarm: ${sensor.id} — ${ev.reason}`,
    verdict === "real" ? "alarm-real" : "alarm-false"
  );
}

// ----- IoT packet builder (sensor → station → server format) -----
function buildPacket(sensor, metrics, alarm) {
  return {
    v: 1,
    station_id: sensor.stationId || null,
    sensor_id:  sensor.id,
    type:       sensor.type,
    ts:         Date.now(),
    battery:    Math.round(sensor.battery * 10) / 10,
    metrics,
    alarm,
  };
}

// ----- Sensor reading loop -----
const scheduled = new WeakSet();

function scheduleSensor(s) {
  if (scheduled.has(s)) return;
  scheduled.add(s);
  const interval = readingIntervalFor(s.type);

  const fire = async () => {
    if (!state.sensors.has(s.id)) return;
    if (s.battery > 0) {
      s.battery  = Math.max(0, s.battery - batteryDrainFor(s.type));
      s.metrics  = nextReading(s.type, s.metrics);
      s.lastUpdate = new Date();

      const alarmFired = checkAlarm(s.type, s.metrics);
      broadcast({ type: "sensor:reading", packet: buildPacket(s, s.metrics, alarmFired) });

      if (alarmFired) {
        await fireAlarm(s, s.metrics).catch((err) => console.error("[fireAlarm]", err.message));
      }
    }
    setTimeout(fire, interval);
  };
  setTimeout(fire, Math.random() * interval);
}

// ----- Boot -----
async function loadFromDb() {
  const stRows = await db.query(
    "SELECT id, name, lat, lng, range_m, created_at FROM signal_stations"
  );
  let maxSS = 0;
  for (const r of stRows.rows) {
    const n = parseInt(r.id.replace(/^SS-/, ""), 10);
    if (Number.isFinite(n) && n > maxSS) maxSS = n;
    state.stations.set(r.id, {
      id: r.id, name: r.name,
      lat: parseFloat(r.lat), lng: parseFloat(r.lng),
      rangeM: parseFloat(r.range_m), createdAt: r.created_at,
    });
  }
  state.stationCounter = maxSS;

  const snRows = await db.query(
    "SELECT id, station_id, type, lat, lng, battery, metrics, alarm_active, comm_range_m, last_update FROM sensors"
  );
  let maxSN = 0;
  for (const r of snRows.rows) {
    const n = parseInt(r.id.replace(/^SN-/, ""), 10);
    if (Number.isFinite(n) && n > maxSN) maxSN = n;
    state.sensors.set(r.id, {
      id: r.id, stationId: r.station_id, type: r.type,
      lat: parseFloat(r.lat), lng: parseFloat(r.lng),
      battery: parseFloat(r.battery),
      metrics: r.metrics, alarmActive: r.alarm_active, lastUpdate: r.last_update,
      commRangeM: parseFloat(r.comm_range_m) || commRangeFor(r.type),
    });
  }
  state.sensorCounter = maxSN;

  const alRows = await db.query(
    "SELECT id, sensor_id, type, ts, verdict, weather_reason FROM alarms ORDER BY ts DESC LIMIT 100"
  );
  for (const r of alRows.rows) {
    state.alarms.set(r.id, {
      id: r.id, sensorId: r.sensor_id, type: r.type,
      ts: r.ts, verdict: r.verdict, weatherReason: r.weather_reason,
    });
  }

  console.log(
    `[boot] ${state.stations.size} stations, ${state.sensors.size} sensors, ${state.alarms.size} alarms`
  );
}

// ----- Station CRUD -----
async function createStation({ name, lat, lng, rangeM }) {
  const r = clamp(
    Number(rangeM) || config.station.defaultRangeM,
    config.station.minRangeM,
    config.station.maxRangeM
  );
  state.stationCounter++;
  const id = `SS-${String(state.stationCounter).padStart(4, "0")}`;
  const stationName = (name && name.trim()) || id;
  await db.query(
    "INSERT INTO signal_stations (id, name, lat, lng, range_m) VALUES ($1, $2, $3, $4, $5)",
    [id, stationName, lat, lng, r]
  );
  const station = { id, name: stationName, lat, lng, rangeM: r, createdAt: new Date() };
  state.stations.set(id, station);
  broadcast({ type: "station:new", station: snapStation(station) });
  logEvent(`Signal station ${id} "${stationName}" placed.`);
  return station;
}

async function deleteStation(id) {
  if (!state.stations.has(id)) return false;
  await db.query("DELETE FROM signal_stations WHERE id = $1", [id]);
  state.stations.delete(id);
  for (const s of state.sensors.values()) if (s.stationId === id) s.stationId = null;
  broadcast({ type: "station:remove", id });
  logEvent(`Signal station ${id} removed.`);
  return true;
}

// ----- Sensor CRUD -----
async function createSensor({ type, lat, lng, stationId }) {
  if (!["wildfire", "flood"].includes(type)) throw new Error("bad sensor type");
  state.sensorCounter++;
  const id = `SN-${String(state.sensorCounter).padStart(4, "0")}`;
  const metrics = nextReading(type, null);
  await db.query(
    `INSERT INTO sensors (id, station_id, type, lat, lng, metrics, last_update)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
    [id, stationId || null, type, lat, lng, JSON.stringify(metrics)]
  );
  const sensor = {
    id, stationId: stationId || null, type, lat, lng,
    battery: 100, metrics, alarmActive: false, lastUpdate: new Date(),
    commRangeM: commRangeFor(type),
  };
  state.sensors.set(id, sensor);
  scheduleSensor(sensor);
  broadcast({ type: "sensor:new", sensor: snapSensor(sensor) });
  logEvent(`Sensor ${id} (${type}) deployed${stationId ? ` → ${stationId}` : ""}.`);
  return sensor;
}

async function deleteSensor(id) {
  if (!state.sensors.has(id)) return false;
  await db.query("DELETE FROM sensors WHERE id = $1", [id]);
  state.sensors.delete(id);
  broadcast({ type: "sensor:remove", id });
  logEvent(`Sensor ${id} removed.`);
  return true;
}

async function updateSensorRange(id, rangeM) {
  const s = state.sensors.get(id);
  if (!s) return false;
  const r = Math.max(200, Math.min(20000, Math.round(Number(rangeM))));
  s.commRangeM = r;
  await db.query("UPDATE sensors SET comm_range_m = $1 WHERE id = $2", [r, id]);
  broadcast({ type: "sensor:range_updated", id, commRangeM: r });
  return true;
}

// ----- Periodic persistence -----
function startPersistence() {
  setInterval(async () => {
    try {
      for (const s of state.sensors.values()) {
        await db.query(
          "UPDATE sensors SET battery=$1, metrics=$2::jsonb, alarm_active=$3, last_update=$4 WHERE id=$5",
          [s.battery, JSON.stringify(s.metrics), s.alarmActive, s.lastUpdate, s.id]
        );
        await db.query(
          "INSERT INTO sensor_readings (sensor_id, metrics, alarm) VALUES ($1, $2::jsonb, $3)",
          [s.id, JSON.stringify(s.metrics), s.alarmActive]
        );
      }
    } catch (err) {
      console.error("[persist]", err.message);
    }
  }, config.history.persistEveryMs);
}

async function start() {
  await loadFromDb();
  for (const s of state.sensors.values()) scheduleSensor(s);
  startPersistence();
  console.log("[sim] running");
}

module.exports = {
  start, buildSnapshot, attachClient, detachClient,
  createStation, deleteStation, createSensor, deleteSensor, updateSensorRange,
};
