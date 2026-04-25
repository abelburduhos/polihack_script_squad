// Simulation: signal stations + individual sensors, alarm lifecycle, weather + AI eval.

const db      = require("./db");
const config  = require("./config");
const weather = require("./weather");
const ai      = require("./ai-analysis");

const state = {
  stations:       new Map(),  // stationId  → station
  sensors:        new Map(),  // sensorId   → sensor
  alarms:         new Map(),  // alarmId    → alarm
  officialAlerts: new Map(),  // alertId    → official alert
  reports:        new Map(),  // reportId   → user report
  clients:        new Set(),
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
function snapOfficialAlert(a) {
  return {
    id: a.id, sensorId: a.sensorId, type: a.type,
    verdict: a.verdict, reasoning: a.reasoning,
    lat: a.lat, lng: a.lng, radiusM: a.radiusM,
    ts: a.ts, active: a.active,
  };
}
function snapReport(r) {
  return {
    id: r.id, type: r.type, lat: r.lat, lng: r.lng,
    ts: r.ts, status: r.status,
  };
}

function generateAlarmMetrics(type) {
  if (type === "wildfire") {
    return {
      co2_ppm:      Math.round(rnd(580, 820)),
      temp_c:       Math.round(rnd(42, 68) * 10) / 10,
      humidity_pct: Math.round(rnd(6, 22) * 10) / 10,
      smoke_index:  Math.round(rnd(0.72, 0.97) * 100) / 100,
    };
  } else {
    return {
      level_cm:      Math.round(rnd(550, 1200)),
      flow_m3s:      Math.round(rnd(1600, 5200)),
      temp_c:        Math.round(rnd(12, 21) * 10) / 10,
      turbidity_ntu: Math.round(rnd(80, 260)),
    };
  }
}
function generateSafeMetrics(type) {
  if (type === "wildfire") {
    return {
      co2_ppm:      Math.round(rnd(395, 435)),
      temp_c:       Math.round(rnd(16, 27) * 10) / 10,
      humidity_pct: Math.round(rnd(48, 72) * 10) / 10,
      smoke_index:  Math.round(rnd(0.01, 0.07) * 100) / 100,
    };
  } else {
    return {
      level_cm:      Math.round(rnd(40, 180)),
      flow_m3s:      Math.round(rnd(80, 380)),
      temp_c:        Math.round(rnd(13, 22) * 10) / 10,
      turbidity_ntu: Math.round(rnd(3, 18)),
    };
  }
}
function buildSnapshot() {
  return {
    stations:       [...state.stations.values()].map(snapStation),
    sensors:        [...state.sensors.values()].map(snapSensor),
    alarms:         [...state.alarms.values()].map(snapAlarm),
    officialAlerts: [...state.officialAlerts.values()].map(snapOfficialAlert),
    reports:        [...state.reports.values()].map(snapReport),
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

  // Run weather check + AI analysis in parallel
  const [ev, aiResult] = await Promise.all([
    weather.evaluateAlarm(sensor.type, sensor.lat, sensor.lng),
    ai.analyzeAlarm(sensor.type, sensor.metrics || {}, sensor.lat, sensor.lng),
  ]);

  // AI WARNING overrides weather denial; weather/AI both needed to clear as false alarm
  const aiWarning  = aiResult.verdict !== "SAFE" && aiResult.verdict !== "UNKNOWN";
  const weatherOk  = ev.confirmed !== false; // true or null (no key configured)
  const verdict    = (aiWarning || weatherOk) ? "real" : "false_alarm";
  const reasonText = `Weather: ${ev.reason} | AI: ${aiResult.verdict} — ${aiResult.reasoning}`;

  alarm.verdict      = verdict;
  alarm.weatherReason = reasonText;

  await db.query(
    `UPDATE alarms SET verdict = $1, weather_data = $2::jsonb, weather_reason = $3 WHERE id = $4`,
    [verdict, JSON.stringify({ weather: ev.weather, ai: aiResult }), reasonText, alarmId]
  );

  if (verdict === "false_alarm") {
    sensor.alarmActive = false;
    await db.query("UPDATE sensors SET alarm_active = FALSE WHERE id = $1", [sensor.id]);
  }

  broadcast({ type: "alarm:verdict", alarm: snapAlarm(alarm) });
  logEvent(
    verdict === "real"
      ? `🔴 REAL: ${sensor.id} — ${reasonText}`
      : `✅ False alarm: ${sensor.id} — ${reasonText}`,
    verdict === "real" ? "alarm-real" : "alarm-false"
  );

  // Issue official alert if AI confirms a warning
  if (aiWarning) {
    await issueOfficialAlert(sensor, aiResult).catch(err => console.error("[official-alert]", err.message));
  }
}

// Affected area radius: wildfire spreads far, flood affects river corridor
const ALERT_RADIUS = { wildfire: 8000, flood: 4000 };

async function issueOfficialAlert(sensor, aiResult) {
  const radiusM = ALERT_RADIUS[sensor.type] ?? 5000;

  const ins = await db.query(
    `INSERT INTO official_alerts (sensor_id, type, verdict, reasoning, lat, lng, radius_m)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, ts`,
    [sensor.id, sensor.type, aiResult.verdict, aiResult.reasoning, sensor.lat, sensor.lng, radiusM]
  );

  const alert = {
    id: ins.rows[0].id, sensorId: sensor.id, type: sensor.type,
    verdict: aiResult.verdict, reasoning: aiResult.reasoning,
    lat: sensor.lat, lng: sensor.lng, radiusM,
    ts: ins.rows[0].ts, active: true,
  };

  state.officialAlerts.set(alert.id, alert);
  broadcast({ type: "alert:official", alert: snapOfficialAlert(alert) });
  logEvent(
    `🚨 OFFICIAL ALERT: ${aiResult.verdict} — ${aiResult.reasoning} (sensor ${sensor.id}, radius ${(radiusM/1000).toFixed(0)} km)`,
    "alert-official"
  );
}

async function dismissOfficialAlert(id) {
  const a = state.officialAlerts.get(id);
  if (!a) return false;
  a.active = false;
  await db.query("UPDATE official_alerts SET active = FALSE WHERE id = $1", [id]);
  broadcast({ type: "alert:dismissed", id });
  return true;
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

  const oaRows = await db.query(
    `SELECT id, sensor_id, type, verdict, reasoning, lat, lng, radius_m, ts, active
     FROM official_alerts WHERE active = TRUE ORDER BY ts DESC LIMIT 50`
  );
  for (const r of oaRows.rows) {
    state.officialAlerts.set(r.id, {
      id: r.id, sensorId: r.sensor_id, type: r.type,
      verdict: r.verdict, reasoning: r.reasoning,
      lat: parseFloat(r.lat), lng: parseFloat(r.lng),
      radiusM: parseFloat(r.radius_m), ts: r.ts, active: r.active,
    });
  }

  const urRows = await db.query(
    "SELECT id, type, lat, lng, ts, status FROM user_reports WHERE status != 'dismissed' ORDER BY ts DESC LIMIT 100"
  );
  for (const r of urRows.rows) {
    const id = Number(r.id);
    state.reports.set(id, {
      id, type: r.type,
      lat: parseFloat(r.lat), lng: parseFloat(r.lng),
      ts: r.ts, status: r.status,
    });
  }

  console.log(
    `[boot] ${state.stations.size} stations, ${state.sensors.size} sensors, ${state.alarms.size} alarms, ${state.officialAlerts.size} active alerts, ${state.reports.size} user reports`
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

// ----- User Reports CRUD -----
async function createReport({ type, lat, lng }) {
  if (!["wildfire", "flood"].includes(type)) throw new Error("bad report type");
  const result = await db.query(
    "INSERT INTO user_reports (type, lat, lng) VALUES ($1, $2, $3) RETURNING id, ts",
    [type, lat, lng]
  );
  const row = result.rows[0];
  const report = { id: Number(row.id), type, lat, lng, ts: row.ts, status: "pending" };
  state.reports.set(report.id, report);
  broadcast({ type: "report:new", report: snapReport(report) });
  logEvent(`Hazard report (${type}) submitted at ${lat.toFixed(3)}, ${lng.toFixed(3)}.`);
  return report;
}

// ----- Sensor fake alarm (AI analysis only, no DB record) -----
async function testSensorAlarm(sensorId, clientWs, scenario = "alarm") {
  const sensor = state.sensors.get(sensorId);
  if (!sensor) return;
  const metrics = scenario === "safe" ? generateSafeMetrics(sensor.type) : generateAlarmMetrics(sensor.type);
  logEvent(`Sensor ${sensorId} ${scenario === "safe" ? "false" : "real"} alarm simulation — querying AI…`);

  const result = await ai.analyzeAlarm(sensor.type, metrics, sensor.lat, sensor.lng);
  const payload = {
    type: "sensor:alarm_result",
    sensorId,
    sensorType: sensor.type,
    scenario,
    metrics,
    verdict:   result.verdict,
    reasoning: result.reasoning,
  };
  if (clientWs && clientWs.readyState === 1) clientWs.send(JSON.stringify(payload));
}

async function confirmReport(id) {
  const r = state.reports.get(id);
  if (!r) return false;
  r.status = "confirmed";
  await db.query("UPDATE user_reports SET status = 'confirmed' WHERE id = $1", [id]);
  broadcast({ type: "report:confirmed", report: snapReport(r) });
  logEvent(`Hazard report ${id} confirmed by admin.`);
  return true;
}

async function dismissReport(id) {
  const r = state.reports.get(id);
  if (!r) return false;
  r.status = "dismissed";
  await db.query("UPDATE user_reports SET status = 'dismissed' WHERE id = $1", [id]);
  broadcast({ type: "report:dismissed", id });
  state.reports.delete(id);
  logEvent(`Hazard report ${id} dismissed by admin.`);
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
  dismissOfficialAlert,
  createReport, confirmReport, dismissReport,
  testSensorAlarm,
};
