// Live Map — default viewer, optional admin login via modal.

// ===== Auth state =====
let CDM_TOKEN = localStorage.getItem("cdm_token") || null;
let CDM_ROLE  = "client";   // default viewer until verified

async function tryRestoreAdmin() {
  if (!CDM_TOKEN) return;
  try {
    const r = await fetch("/api/me", { headers: { Authorization: `Bearer ${CDM_TOKEN}` } });
    if (r.ok) {
      const d = await r.json();
      if (d.role === "admin") { CDM_ROLE = "admin"; }
      else { CDM_TOKEN = null; localStorage.removeItem("cdm_token"); }
    } else {
      CDM_TOKEN = null;
      localStorage.removeItem("cdm_token");
    }
  } catch { CDM_TOKEN = null; }
}

function applyAdminUI() {
  const badge    = document.getElementById("user-badge");
  const adminBtn = document.getElementById("admin-btn");
  const isAdmin  = CDM_ROLE === "admin";

  badge.classList.toggle("hidden", !isAdmin);
  adminBtn.textContent = isAdmin ? "Logout Admin" : "Admin Login";

  document.getElementById("place-station-section").classList.toggle("hidden", !isAdmin);
  document.getElementById("place-sensor-section").classList.toggle("hidden", !isAdmin);

  // Refresh lists to add/remove delete buttons
  refreshStationList();
  refreshSensorList();
}

// ===== Map =====
const map = L.map("map", { center: CONFIG.map.center, zoom: CONFIG.map.zoom });
L.tileLayer(CONFIG.map.tile.url, {
  maxZoom: CONFIG.map.tile.maxZoom,
  attribution: CONFIG.map.tile.attribution,
  subdomains: CONFIG.map.tile.subdomains,
}).addTo(map);

// ===== Layers =====
const alertLayer        = L.layerGroup().addTo(map);   // official alert circles (top)
const wildfireLayer     = L.layerGroup().addTo(map);
const floodLayer        = L.layerGroup().addTo(map);
const stationLayer      = L.layerGroup().addTo(map);
const sensorCommLayer   = L.layerGroup().addTo(map);  // comm range circles (default on)
const sensorRadiusLayer = L.layerGroup();              // detection radii (default off)

// ===== Activity log =====
const logEl = document.getElementById("activity-log");
function appendLog(message, kind, time) {
  logEl.querySelector(".log-empty")?.remove();
  const li = document.createElement("li");
  li.className = `log-entry ${kind || ""}`;
  const t   = time ? new Date(time) : new Date();
  const fmt = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  li.innerHTML = `<span class="log-time">${fmt}</span> ${message}`;
  logEl.prepend(li);
  while (logEl.children.length > 60) logEl.lastChild.remove();
}

// ===== Helpers =====
function batteryColor(pct, base = "#3ec48b") {
  if (pct <= 0) return "#3b3f47";
  if (pct < 20) return "#ff5b3b";
  if (pct < 50) return "#ffb340";
  return base;
}
function batteryHtml(pct) {
  const p = Math.max(0, Math.min(100, pct)), c = batteryColor(p);
  return `<span class="battery"><span class="battery-bar"><span class="battery-fill" style="width:${p}%;background:${c}"></span></span><span class="battery-text">${Math.round(p)}%</span></span>`;
}
function metricRow(label, value, unit) {
  if (value == null) return "";
  return `<tr><td>${label}</td><td><strong>${value}</strong> <span class="unit">${unit || ""}</span></td></tr>`;
}
function sensorTooltipHtml(s) {
  const m = s.metrics || {};
  let rows = s.type === "wildfire"
    ? metricRow("CO₂", m.co2_ppm, "ppm") + metricRow("Temperature", m.temp_c, "°C") +
      metricRow("Humidity", m.humidity_pct, "%") + metricRow("Smoke index", m.smoke_index, "")
    : metricRow("Water level", m.level_cm, "cm") + metricRow("Flow rate", m.flow_m3s, "m³/s") +
      metricRow("Temperature", m.temp_c, "°C") + metricRow("Turbidity", m.turbidity_ntu, "NTU");
  const ts  = s.lastUpdate ? new Date(s.lastUpdate).toLocaleTimeString() : "—";
  const stT = s.stationId   ? `<span class="tip-station">${s.stationId}</span>` : "";
  const alT = s.alarmActive ? `<span class="tip-alarm">⚠ ALARM</span>` : "";
  return `<div class="sensor-tip"><div class="sensor-tip-head"><strong>${s.id}</strong> · ${s.type} ${stT} ${alT}</div><table class="metrics">${rows}</table><div class="sensor-tip-foot">${batteryHtml(s.battery)} · ${ts}</div></div>`;
}

// ===== Haversine (client-side connectivity) =====
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = d => d * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ===== Connectivity BFS =====
// Sensor A is connected if A.commRangeM reaches a station OR a connected sensor.
function computeConnected() {
  const connected = new Set();
  const sensors   = [...sensorViews.values()];
  const stations  = [...stationViews.values()];
  const queue     = [];

  for (const s of sensors) {
    for (const st of stations) {
      if (haversineM(s.lat, s.lng, st.lat, st.lng) <= s.commRangeM) {
        connected.add(s.id);
        queue.push(s);
        break;
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const relay = queue[head++];
    for (const s of sensors) {
      if (connected.has(s.id)) continue;
      if (haversineM(s.lat, s.lng, relay.lat, relay.lng) <= s.commRangeM) {
        connected.add(s.id);
        queue.push(s);
      }
    }
  }
  return connected;
}

const GREY = "#4a525c";

function refreshConnectivity() {
  const connected = computeConnected();
  for (const [id, v] of sensorViews) {
    const isConn = connected.has(id);
    v.connected  = isConn;
    const color  = isConn ? v.baseColor : GREY;
    v.marker.setStyle({
      fillColor: v.alarmActive ? "#ff2200" : color,
      color:     v.alarmActive ? "#ff2200" : "#0a0e14",
    });
    v.commCircle.setStyle({ color, fillColor: color, opacity: isConn ? 0.45 : 0.2, fillOpacity: isConn ? 0.06 : 0.02 });
    const el = v.marker.getElement?.();
    if (el) el.classList.toggle("alarm-pulse", !!v.alarmActive);
  }
}

// ===== View models =====
const stationViews      = new Map();
const sensorViews       = new Map();
const alarmMap          = new Map();
const officialAlertViews = new Map();  // alertId → { circle, ...data }
const reportViews       = new Map();   // reportId → { marker, ...data }

const STATION_BODY_M = 600; // geo-scaled icon radius for signal stations

function upsertStation(st) {
  let v = stationViews.get(st.id);
  const tip = `<div class="station-tip"><strong>${st.id}</strong><br>${st.name}</div>`;
  if (!v) {
    const body = L.circle([st.lat, st.lng], {
      radius: STATION_BODY_M,
      color: "#a78bfa", weight: 2.5,
      fillColor: "#6d28d9", fillOpacity: 0.75,
    })
      .addTo(stationLayer)
      .bindTooltip(tip, { direction: "top", sticky: true, className: "sensor-tooltip" });
    v = { ...st, body };
    stationViews.set(st.id, v);
  } else {
    Object.assign(v, st);
    v.body.setTooltipContent(tip);
  }
  refreshStationList();
  refreshStationSelect();
  refreshConnectivity();
  return v;
}

function removeStation(id) {
  const v = stationViews.get(id);
  if (!v) return;
  stationLayer.removeLayer(v.body);
  stationViews.delete(id);
  refreshStationList();
  refreshStationSelect();
  refreshConnectivity();
}

function upsertSensor(s) {
  let v = sensorViews.get(s.id);
  const baseColor = s.type === "wildfire" ? "#ff6b3a" : "#4aa3d6";
  const layer     = s.type === "wildfire" ? wildfireLayer : floodLayer;

  if (!v) {
    const marker = L.circleMarker([s.lat, s.lng], {
      radius: 6, color: "#0a0e14", weight: 1.5,
      fillColor: baseColor, fillOpacity: 0.95,
    }).addTo(layer);

    // Comm range circle (geo-scaled, shows connectivity reach)
    const commCircle = L.circle([s.lat, s.lng], {
      radius: s.commRangeM,
      color: baseColor, weight: 1.5, opacity: 0.45,
      fillColor: baseColor, fillOpacity: 0.06,
      dashArray: "5 6", interactive: false,
    }).addTo(sensorCommLayer);

    // Detection radius circle (optional layer)
    const radiusCircle = L.circle([s.lat, s.lng], {
      radius: s.detectionRadiusM,
      color: baseColor, weight: 1, opacity: 0.2,
      fillColor: baseColor, fillOpacity: 0.04,
      interactive: false,
    }).addTo(sensorRadiusLayer);

    marker.bindTooltip(sensorTooltipHtml(s), {
      direction: "top", offset: [0, -4], sticky: true, className: "sensor-tooltip",
    });
    marker.on("click", () => showSensorDetail(s.id));

    v = { ...s, marker, commCircle, radiusCircle, baseColor, layer };
    sensorViews.set(s.id, v);
  } else {
    const oldRange = v.commRangeM;
    Object.assign(v, s);
    // Update comm circle radius if range changed
    if (s.commRangeM !== undefined && s.commRangeM !== oldRange) {
      v.commCircle.setRadius(s.commRangeM);
    }
    v.marker.setStyle({
      fillColor: v.alarmActive ? "#ff2200" : v.baseColor,
      color:     v.alarmActive ? "#ff2200" : "#0a0e14",
      weight:    v.alarmActive ? 2.5 : 1.5,
    });
    const el = v.marker.getElement?.();
    if (el) el.classList.toggle("alarm-pulse", !!v.alarmActive);
    v.marker.setTooltipContent(sensorTooltipHtml(v));
  }
  refreshSensorList();
  refreshConnectivity();
  return v;
}

function removeSensor(id) {
  const v = sensorViews.get(id);
  if (!v) return;
  v.layer.removeLayer(v.marker);
  sensorCommLayer.removeLayer(v.commCircle);
  sensorRadiusLayer.removeLayer(v.radiusCircle);
  sensorViews.delete(id);
  if (selectedSensorId === id) hideSensorDetail();
  refreshSensorList();
  refreshConnectivity();
}

// ===== Panel lists =====
const stationCountEl = document.getElementById("station-count");
const stationListEl  = document.getElementById("station-list");
const sensorCountEl  = document.getElementById("sensor-count");
const sensorListEl   = document.getElementById("sensor-list");
const alarmCountEl   = document.getElementById("alarm-count");
const alarmListEl    = document.getElementById("alarm-list");

function refreshStationList() {
  stationCountEl.textContent = stationViews.size;
  stationListEl.innerHTML = "";
  if (!stationViews.size) { stationListEl.innerHTML = '<li class="log-empty">No stations yet.</li>'; return; }
  for (const st of [...stationViews.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const sc = [...sensorViews.values()].filter(s => s.stationId === st.id).length;
    const li = document.createElement("li");
    li.className = "item-row type-station";
    li.innerHTML =
      `<span class="item-id">${st.id}</span>` +
      `<span class="item-meta">${st.name} · ${sc} sensors</span>` +
      (CDM_ROLE === "admin" ? `<button class="item-del" data-type="station" data-id="${st.id}" title="Delete">×</button>` : "");
    stationListEl.appendChild(li);
  }
}

function refreshSensorList() {
  sensorCountEl.textContent = sensorViews.size;
  sensorListEl.innerHTML = "";
  if (!sensorViews.size) { sensorListEl.innerHTML = '<li class="log-empty">No sensors yet.</li>'; return; }
  for (const s of [...sensorViews.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const li = document.createElement("li");
    const connClass = s.connected === false ? " disconnected" : "";
    li.className = `item-row type-${s.type}${s.alarmActive ? " alarm-row" : ""}${connClass}`;
    const stTag = s.stationId ? `<span class="item-station">${s.stationId}</span>` : "";
    const connIcon = s.connected === false ? `<span class="item-disconn" title="Out of range">⚠</span>` : "";
    li.innerHTML =
      `<span class="item-id">${s.id}</span>` +
      `<span class="item-meta">${s.type} ${stTag} ${connIcon}</span>` +
      (CDM_ROLE === "admin" ? `<button class="item-del" data-type="sensor" data-id="${s.id}" title="Delete">×</button>` : "");
    stationListEl === stationListEl; // lint noop
    sensorListEl.appendChild(li);
  }
}

function refreshStationSelect() {
  const sel = document.getElementById("sensor-station");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— None —</option>';
  for (const st of [...stationViews.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const opt = document.createElement("option");
    opt.value = st.id;
    opt.textContent = `${st.id} — ${st.name}`;
    sel.appendChild(opt);
  }
  if (cur) sel.value = cur;
}

function upsertAlarm(a) {
  alarmMap.set(a.id, a);
  refreshAlarmList();
}
function refreshAlarmList() {
  const alarms = [...alarmMap.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 30);
  alarmCountEl.textContent = alarms.filter(a => a.verdict === "pending" || a.verdict === "real").length;
  alarmListEl.innerHTML = alarms.length ? "" : '<li class="log-empty">No alarms.</li>';
  for (const a of alarms) {
    const vC = { pending: "alarm-pending", real: "alarm-real", false_alarm: "alarm-false" }[a.verdict] || "";
    const vI = { pending: "⏳", real: "🔴", false_alarm: "✅" }[a.verdict] || "?";
    const ts = new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const li = document.createElement("li");
    li.className = `alarm-item ${vC}`;
    li.innerHTML = `<span class="alarm-icon">${vI}</span><span class="alarm-body"><strong>${a.sensorId}</strong> <span class="alarm-type">${a.type}</span><br><span class="alarm-reason">${a.weatherReason || "Evaluating…"}</span></span><span class="alarm-time">${ts}</span>`;
    alarmListEl.appendChild(li);
  }
}

// ===== Official alerts (map + panel) =====
const officialAlertCountEl = document.getElementById("official-alert-count");
const officialAlertListEl  = document.getElementById("official-alert-list");

function upsertOfficialAlert(a) {
  let v = officialAlertViews.get(a.id);
  const color = a.type === "wildfire" ? "#ff3300" : "#1a88ff";

  if (!v) {
    const circle = L.circle([a.lat, a.lng], {
      radius: a.radiusM,
      color, weight: 2.5, opacity: 0.85,
      fillColor: color, fillOpacity: 0.12,
      dashArray: null,
      interactive: true,
      className: "alert-circle",
    }).addTo(alertLayer)
      .bindTooltip(
        `<div class="station-tip"><strong>${a.verdict}</strong><br>${a.reasoning}<br><em style="color:var(--muted)">${a.sensorId} · ${(a.radiusM/1000).toFixed(0)} km radius</em></div>`,
        { direction: "top", sticky: true, className: "sensor-tooltip" }
      );
    v = { ...a, circle };
    officialAlertViews.set(a.id, v);
  } else {
    Object.assign(v, a);
  }
  refreshOfficialAlertList();
}

function removeOfficialAlert(id) {
  const v = officialAlertViews.get(id);
  if (!v) return;
  alertLayer.removeLayer(v.circle);
  officialAlertViews.delete(id);
  refreshOfficialAlertList();
}

function refreshOfficialAlertList() {
  const alerts = [...officialAlertViews.values()].filter(a => a.active).sort((a, b) => new Date(b.ts) - new Date(a.ts));
  officialAlertCountEl.textContent = alerts.length;
  officialAlertListEl.innerHTML = alerts.length ? "" : '<li class="log-empty">No active alerts.</li>';
  for (const a of alerts) {
    const color = a.type === "wildfire" ? "var(--fire)" : "var(--flood)";
    const li = document.createElement("li");
    li.className = `official-alert-item type-${a.type}`;
    const ts = new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.innerHTML =
      `<div class="oa-header">` +
      `<span class="oa-verdict" style="color:${color}">${a.verdict}</span>` +
      `<span class="oa-time">${ts}</span>` +
      (CDM_ROLE === "admin" ? `<button class="item-del" data-type="alert" data-id="${a.id}" title="Dismiss">×</button>` : "") +
      `</div>` +
      `<div class="oa-reason">${a.reasoning}</div>` +
      `<div class="oa-meta">${a.sensorId} · ${(a.radiusM / 1000).toFixed(0)} km radius</div>`;
    officialAlertListEl.appendChild(li);
  }
}

// ===== User reports (map + panel) =====
const reportCountEl = document.getElementById("report-count");
const reportListEl  = document.getElementById("report-list");
const reportLayer   = L.layerGroup().addTo(map);

function upsertReport(r) {
  let v = reportViews.get(r.id);
  const baseColor = r.type === "wildfire" ? "#ff6b3a" : "#4aa3d6";
  const emoji = r.type === "wildfire" ? "🔥" : "🌊";
  const typeLabel = r.type === "wildfire" ? "Wildfire" : "Flood";

  if (!v) {
    const icon = L.divIcon({
      html: `<div class="report-marker" style="background:${baseColor}">!</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      className: "report-divicon",
    });
    const marker = L.marker([r.lat, r.lng], { icon })
      .addTo(reportLayer)
      .bindTooltip(`${emoji} ${typeLabel} Report`, { sticky: true, className: "sensor-tooltip" });
    marker.on("click", () => map.panTo([r.lat, r.lng]));
    v = { ...r, marker, baseColor };
    reportViews.set(r.id, v);
  } else {
    Object.assign(v, r);
  }
  refreshReportList();
}

function removeReport(id) {
  const v = reportViews.get(id);
  if (!v) return;
  reportLayer.removeLayer(v.marker);
  reportViews.delete(id);
  refreshReportList();
}

function refreshReportList() {
  const reports = [...reportViews.values()].filter(r => r.status !== "dismissed").sort((a, b) => new Date(b.ts) - new Date(a.ts));
  reportCountEl.textContent = reports.filter(r => r.status === "pending").length;
  reportListEl.innerHTML = reports.length ? "" : '<li class="log-empty">No reports yet.</li>';
  for (const r of reports) {
    const emoji = r.type === "wildfire" ? "🔥" : "🌊";
    const typeLabel = r.type === "wildfire" ? "Wildfire" : "Flood";
    const ts = new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const statusColor = r.status === "pending" ? "var(--pending)" : "var(--sensor)";
    const li = document.createElement("li");
    li.className = `report-item type-${r.type}`;
    let html =
      `<span class="report-icon">${emoji}</span>` +
      `<span class="report-body">` +
        `<strong>${typeLabel} Report</strong>` +
        `<span class="report-coords">${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}</span>` +
        `<span class="report-status" style="color:${statusColor}">${r.status}</span>` +
      `</span>` +
      `<span class="report-time">${ts}</span>`;
    if (CDM_ROLE === "admin") {
      html += `<button class="item-action" data-action="confirm" data-id="${r.id}" title="Confirm">✓</button>`;
      html += `<button class="item-del" data-type="report" data-id="${r.id}" title="Dismiss">×</button>`;
    }
    li.innerHTML = html;
    reportListEl.appendChild(li);
  }
}

// ===== Sensor fake alarm =====
function verdictColor(v) {
  if (v === "FOREST_FIRE_WARNING") return "var(--fire)";
  if (v === "FLOOD_WARNING")       return "var(--flood)";
  if (v === "SAFE")                return "var(--sensor)";
  return "var(--muted)";
}
function verdictLabel(v) {
  if (v === "FOREST_FIRE_WARNING") return "🔥 REAL ALARM — Wildfire confirmed";
  if (v === "FLOOD_WARNING")       return "🌊 REAL ALARM — Flood confirmed";
  if (v === "SAFE")                return "✅ FALSE ALARM — No threat detected";
  if (v === "UNKNOWN")             return "⚠ No API key — set OPENAI_API_KEY in .env";
  return `⚠ ${v}`;
}

const fakeAlarmBtn      = document.getElementById("detail-fake-alarm-btn");
const fakeFalseAlarmBtn = document.getElementById("detail-fake-false-alarm-btn");
const alarmResultBox    = document.getElementById("detail-alarm-result");
const alarmMetricsEl    = document.getElementById("detail-alarm-metrics");
const alarmVerdictEl    = document.getElementById("detail-alarm-verdict");
const alarmReasoningEl  = document.getElementById("detail-alarm-reasoning");

function resetAlarmBtns() {
  fakeAlarmBtn.disabled      = false;
  fakeFalseAlarmBtn.disabled = false;
  fakeAlarmBtn.textContent      = "⚡ Simulate Real Alarm";
  fakeFalseAlarmBtn.textContent = "✓ Simulate False Alarm";
}

function setAlarmBtnsLoading() {
  fakeAlarmBtn.disabled = fakeFalseAlarmBtn.disabled = true;
  fakeAlarmBtn.textContent = fakeFalseAlarmBtn.textContent = "⏳ Querying AI…";
}

fakeAlarmBtn.addEventListener("click", () => {
  if (!selectedSensorId || !ws || ws.readyState !== 1) return;
  setAlarmBtnsLoading();
  alarmResultBox.hidden = true;
  ws.send(JSON.stringify({ type: "sensor:fake_alarm", id: selectedSensorId }));
});

fakeFalseAlarmBtn.addEventListener("click", () => {
  if (!selectedSensorId || !ws || ws.readyState !== 1) return;
  setAlarmBtnsLoading();
  alarmResultBox.hidden = true;
  ws.send(JSON.stringify({ type: "sensor:fake_false_alarm", id: selectedSensorId }));
});

function showAlarmResult(msg) {
  const m = msg.metrics || {};
  let metricsText = "";
  if (msg.sensorType === "wildfire") {
    metricsText = `CO₂: ${m.co2_ppm} ppm · Temp: ${m.temp_c}°C · Humidity: ${m.humidity_pct}% · Smoke: ${m.smoke_index}`;
  } else {
    metricsText = `Level: ${m.level_cm} cm · Flow: ${m.flow_m3s} m³/s · Turbidity: ${m.turbidity_ntu} NTU`;
  }
  const isSafe    = msg.verdict === "SAFE";
  const isUnknown = msg.verdict === "UNKNOWN";
  const color = verdictColor(msg.verdict);
  alarmMetricsEl.textContent   = `[${msg.scenario === "safe" ? "safe metrics" : "alarm metrics"}] ${metricsText}`;
  alarmVerdictEl.textContent   = verdictLabel(msg.verdict);
  alarmVerdictEl.style.color   = color;
  alarmReasoningEl.textContent = msg.reasoning || "";
  alarmResultBox.hidden = false;
  alarmResultBox.className = `alarm-result-box ${isSafe ? "result-safe" : isUnknown ? "" : "result-warning"}`;
  resetAlarmBtns();
}

// Delete/confirm buttons for reports (admin only)
document.addEventListener("click", (e) => {
  if (CDM_ROLE !== "admin" || !ws || ws.readyState !== 1) return;
  const btn = e.target.closest(".item-action, .item-del");
  if (!btn) return;
  const { type, action, id } = btn.dataset;
  if (action === "confirm") ws.send(JSON.stringify({ type: "report:confirm", id: Number(id) }));
  else if (type === "report") ws.send(JSON.stringify({ type: "report:dismiss", id: Number(id) }));
  else if (type === "station") ws.send(JSON.stringify({ type: "station:delete", id }));
  else if (type === "sensor") ws.send(JSON.stringify({ type: "sensor:delete", id }));
  else if (type === "alert") ws.send(JSON.stringify({ type: "alert:dismiss", id: Number(id) }));
});

// ===== Sensor detail panel =====
let selectedSensorId = null;
const detailSection  = document.getElementById("sensor-detail-section");
const detailIdEl     = document.getElementById("detail-id");
const detailConnEl   = document.getElementById("detail-conn");
function showSensorDetail(sensorId) {
  const v = sensorViews.get(sensorId);
  if (!v) return;
  selectedSensorId = sensorId;
  detailIdEl.textContent = sensorId;
  detailConnEl.textContent = v.connected === false ? "⚠ Out of range — no path to station" : "✓ Connected";
  detailConnEl.className = `detail-conn-badge ${v.connected === false ? "conn-no" : "conn-yes"}`;
  alarmResultBox.hidden = true;
  resetAlarmBtns();
  detailSection.hidden = false;
}

function hideSensorDetail() {
  selectedSensorId = null;
  detailSection.hidden = true;
  alarmResultBox.hidden = true;
  resetAlarmBtns();
}

document.getElementById("detail-close").addEventListener("click", hideSensorDetail);

// ===== Snapshot =====
function applySnapshot(snap) {
  for (const v of stationViews.values()) stationLayer.removeLayer(v.body);
  stationViews.clear();
  for (const v of sensorViews.values()) {
    v.layer.removeLayer(v.marker);
    sensorCommLayer.removeLayer(v.commCircle);
    sensorRadiusLayer.removeLayer(v.radiusCircle);
  }
  sensorViews.clear();
  alarmMap.clear();
  for (const v of reportViews.values()) reportLayer.removeLayer(v.marker);
  reportViews.clear();

  for (const st of snap.stations || []) {
    const body = L.circle([st.lat, st.lng], {
      radius: STATION_BODY_M, color: "#a78bfa", weight: 2.5,
      fillColor: "#6d28d9", fillOpacity: 0.75,
    }).addTo(stationLayer)
      .bindTooltip(`<div class="station-tip"><strong>${st.id}</strong><br>${st.name}</div>`,
        { direction: "top", sticky: true, className: "sensor-tooltip" });
    stationViews.set(st.id, { ...st, body });
  }
  for (const s of snap.sensors || []) {
    const baseColor = s.type === "wildfire" ? "#ff6b3a" : "#4aa3d6";
    const layer     = s.type === "wildfire" ? wildfireLayer : floodLayer;
    const marker    = L.circleMarker([s.lat, s.lng], {
      radius: 6, color: "#0a0e14", weight: 1.5,
      fillColor: baseColor, fillOpacity: 0.95,
    }).addTo(layer);
    const commCircle = L.circle([s.lat, s.lng], {
      radius: s.commRangeM, color: baseColor, weight: 1.5, opacity: 0.45,
      fillColor: baseColor, fillOpacity: 0.06, dashArray: "5 6", interactive: false,
    }).addTo(sensorCommLayer);
    const radiusCircle = L.circle([s.lat, s.lng], {
      radius: s.detectionRadiusM, color: baseColor, weight: 1, opacity: 0.2,
      fillColor: baseColor, fillOpacity: 0.04, interactive: false,
    }).addTo(sensorRadiusLayer);
    marker.bindTooltip(sensorTooltipHtml(s),
      { direction: "top", offset: [0, -4], sticky: true, className: "sensor-tooltip" });
    const sid = s.id;
    marker.on("click", () => showSensorDetail(sid));
    sensorViews.set(s.id, { ...s, marker, commCircle, radiusCircle, baseColor, layer });
  }
  for (const v of officialAlertViews.values()) alertLayer.removeLayer(v.circle);
  officialAlertViews.clear();

  for (const a of snap.alarms         || []) alarmMap.set(a.id, a);
  for (const a of snap.officialAlerts || []) if (a.active) upsertOfficialAlert(a);
  for (const r of snap.reports        || []) upsertReport(r);

  refreshStationList();
  refreshSensorList();
  refreshStationSelect();
  refreshAlarmList();
  refreshOfficialAlertList();
  refreshReportList();
  refreshConnectivity();
}

// ===== WebSocket =====
let ws;
function connect() {
  const proto     = location.protocol === "https:" ? "wss:" : "ws:";
  const tokenPart = CDM_TOKEN ? `?token=${encodeURIComponent(CDM_TOKEN)}` : "";
  ws = new WebSocket(`${proto}//${location.host}${tokenPart}`);

  ws.addEventListener("open",  () => appendLog("Connected.", "info"));
  ws.addEventListener("close", () => { appendLog("Disconnected — retrying in 2 s.", "deny"); setTimeout(connect, 2000); });
  ws.addEventListener("error", () => {});

  ws.addEventListener("message", (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "snapshot":      applySnapshot(msg.data); break;
      case "station:new":   upsertStation(msg.station); break;
      case "station:remove": removeStation(msg.id); break;
      case "sensor:new":    upsertSensor(msg.sensor); break;
      case "sensor:remove": removeSensor(msg.id); break;
      case "sensor:reading": {
        const p = msg.packet, v = sensorViews.get(p.sensor_id);
        if (v) upsertSensor({ ...v, battery: p.battery, metrics: p.metrics, lastUpdate: new Date(p.ts) });
        break;
      }
      case "sensor:range_updated": {
        const v = sensorViews.get(msg.id);
        if (v) {
          v.commRangeM = msg.commRangeM;
          v.commCircle.setRadius(msg.commRangeM);
          refreshConnectivity();
          // Update detail panel if this sensor is selected
          if (selectedSensorId === msg.id) {
            detailRangeEl.value = msg.commRangeM;
            detailRangeOut.textContent = fmtKm(msg.commRangeM);
          }
        }
        break;
      }
      case "alarm:new":
        upsertAlarm(msg.alarm);
        { const v = sensorViews.get(msg.alarm.sensorId);
          if (v) upsertSensor({ ...v, alarmActive: true }); }
        break;
      case "alarm:verdict":
        upsertAlarm(msg.alarm);
        if (msg.alarm.verdict === "false_alarm") {
          const v = sensorViews.get(msg.alarm.sensorId);
          if (v) upsertSensor({ ...v, alarmActive: false });
        }
        break;
      case "alert:official":
        upsertOfficialAlert(msg.alert);
        break;
      case "alert:dismissed":
        removeOfficialAlert(msg.id);
        break;
      case "report:new":
        upsertReport(msg.report);
        break;
      case "report:confirmed":
        upsertReport(msg.report);
        break;
      case "report:dismissed":
        removeReport(msg.id);
        break;
      case "sensor:alarm_result":
        if (msg.sensorId === selectedSensorId) showAlarmResult(msg);
        break;
      case "error":   appendLog(`Error: ${msg.message}`, "deny"); break;
      case "log":     appendLog(msg.message, msg.kind, msg.time); break;
    }
  });
}

// ===== Layer filters =====
function bindFilter(id, layers, on = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.checked = on;
  el.addEventListener("change", e => layers.forEach(l => e.target.checked ? l.addTo(map) : map.removeLayer(l)));
}
bindFilter("filter-wildfire",      [wildfireLayer]);
bindFilter("filter-flood",         [floodLayer]);
bindFilter("filter-stations",      [stationLayer]);
bindFilter("filter-sensor-comm",   [sensorCommLayer]);
bindFilter("filter-sensor-radius", [sensorRadiusLayer], false);

// ===== Placement mode (admin placement + user reports) =====
let placingMode = "none";
let reportType  = null;  // "wildfire" or "flood" for report mode
let preview     = null;

const placeStationBtn = document.getElementById("place-station-btn");
const placeSensorBtn  = document.getElementById("place-sensor-btn");
const sensorTypeEl    = document.getElementById("sensor-type");

function clearPreview() { if (preview) { preview.remove(); preview = null; } }
function setPlacingMode(mode) {
  placingMode = mode; clearPreview();
  placeStationBtn?.classList.toggle("active", mode === "station");
  placeSensorBtn?.classList.toggle("active",  mode === "sensor");
  if (placeStationBtn) placeStationBtn.textContent = mode === "station" ? "Cancel" : "Click map to place";
  if (placeSensorBtn)  placeSensorBtn.textContent  = mode === "sensor"  ? "Cancel" : "Click map to place";
  map.getContainer().classList.toggle("placing", mode !== "none");
  if (mode !== "report") {
    reportType = null;
    document.getElementById("report-modal").hidden = true;
    const hint = document.getElementById("report-placement-hint");
    if (hint) hint.hidden = true;
  }
}

placeStationBtn?.addEventListener("click", () => setPlacingMode(placingMode === "station" ? "none" : "station"));
placeSensorBtn?.addEventListener("click",  () => setPlacingMode(placingMode === "sensor"  ? "none" : "sensor"));

map.on("mousemove", e => {
  if (placingMode === "none") return;
  if ((placingMode === "station" || placingMode === "sensor") && CDM_ROLE !== "admin") return;
  const latlng = e.latlng;
  if (placingMode === "station") {
    if (!preview) preview = L.circle(latlng, { radius: STATION_BODY_M * 3, color: "#a78bfa", weight: 2, opacity: 0.7, fillColor: "#a78bfa", fillOpacity: 0.08, dashArray: "5 5", interactive: false }).addTo(map);
    else preview.setLatLng(latlng);
  } else if (placingMode === "sensor") {
    const isWF = sensorTypeEl.value === "wildfire", c = isWF ? "#ff6b3a" : "#4aa3d6", detR = isWF ? 300 : 800;
    if (!preview) preview = L.circle(latlng, { radius: detR, color: c, weight: 1.5, opacity: 0.65, fillColor: c, fillOpacity: 0.08, interactive: false }).addTo(map);
    else { preview.setLatLng(latlng); preview.setRadius(detR); preview.setStyle({ color: c, fillColor: c }); }
  } else if (placingMode === "report") {
    const isWF = reportType === "wildfire", c = isWF ? "#ff6b3a" : "#4aa3d6", detR = isWF ? 300 : 800;
    if (!preview) preview = L.circle(latlng, { radius: detR, color: c, weight: 1.5, opacity: 0.65, fillColor: c, fillOpacity: 0.08, interactive: false }).addTo(map);
    else { preview.setLatLng(latlng); preview.setRadius(detR); preview.setStyle({ color: c, fillColor: c }); }
  }
});

sensorTypeEl?.addEventListener("change", () => {
  if (!preview || placingMode !== "sensor") return;
  const isWF = sensorTypeEl.value === "wildfire";
  preview.setStyle({ color: isWF ? "#ff6b3a" : "#4aa3d6", fillColor: isWF ? "#ff6b3a" : "#4aa3d6" });
  preview.setRadius(isWF ? 300 : 800);
});

map.on("click", e => {
  if (placingMode === "none" || !ws || ws.readyState !== 1) return;
  const { lat, lng } = e.latlng;

  // Admin-only placements
  if ((placingMode === "station" || placingMode === "sensor") && CDM_ROLE !== "admin") return;

  if (placingMode === "station") {
    ws.send(JSON.stringify({ type: "station:create", name: document.getElementById("station-name")?.value.trim() || null, lat, lng }));
    const nameEl = document.getElementById("station-name");
    if (nameEl) nameEl.value = "";
  } else if (placingMode === "sensor") {
    ws.send(JSON.stringify({ type: "sensor:create", sensorType: sensorTypeEl.value, stationId: document.getElementById("sensor-station")?.value || null, lat, lng }));
  } else if (placingMode === "report") {
    ws.send(JSON.stringify({ type: "report:create", reportType, lat, lng }));
    appendLog(`${reportType === "wildfire" ? "🔥" : "🌊"} Hazard report submitted — check User Reports panel.`, "info");
    hidePlacementHint();
  }
  setPlacingMode("none");
});

// ===== Report modal (hazard wizard) =====
const reportBtn       = document.getElementById("report-btn");
const reportModal     = document.getElementById("report-modal");
const step1           = document.getElementById("report-step-1");
const placementHint   = document.getElementById("report-placement-hint");
const hintLabel       = document.getElementById("report-hint-label");

function showPlacementHint(type) {
  const emoji = type === "wildfire" ? "🔥" : "🌊";
  const label = type === "wildfire" ? "Wildfire" : "Flood";
  hintLabel.textContent = `${emoji} Click map to mark ${label} hazard location`;
  placementHint.hidden = false;
}
function hidePlacementHint() {
  placementHint.hidden = true;
}

reportBtn.addEventListener("click", () => {
  reportModal.hidden = false;
  step1.hidden = false;
  reportType = null;
});

document.getElementById("report-modal-close-btn").addEventListener("click", () => {
  reportModal.hidden = true;
  setPlacingMode("none");
});
reportModal.addEventListener("click", e => { if (e.target === reportModal) { reportModal.hidden = true; setPlacingMode("none"); } });

// Hazard card selection — close modal, show map hint, enter placement mode
document.getElementById("hazard-wildfire").addEventListener("click", () => {
  reportType = "wildfire";
  reportModal.hidden = true;
  showPlacementHint("wildfire");
  setPlacingMode("report");
});

document.getElementById("hazard-flood").addEventListener("click", () => {
  reportType = "flood";
  reportModal.hidden = true;
  showPlacementHint("flood");
  setPlacingMode("report");
});

document.getElementById("report-cancel-btn").addEventListener("click", () => {
  hidePlacementHint();
  setPlacingMode("none");
});

// ===== Admin modal =====
const adminBtn   = document.getElementById("admin-btn");
const adminModal = document.getElementById("admin-modal");

adminBtn.addEventListener("click", () => {
  if (CDM_ROLE === "admin") {
    // Logout
    CDM_TOKEN = null; CDM_ROLE = "client";
    localStorage.removeItem("cdm_token");
    localStorage.removeItem("cdm_role");
    hideSensorDetail();
    setPlacingMode("none");
    applyAdminUI();
    // Reconnect as viewer
    if (ws) ws.close();
  } else {
    adminModal.hidden = false;
    document.getElementById("modal-username").focus();
  }
});

document.getElementById("modal-close-btn").addEventListener("click", () => {
  adminModal.hidden = true;
});
adminModal.addEventListener("click", e => { if (e.target === adminModal) adminModal.hidden = true; });

document.getElementById("admin-form").addEventListener("submit", async e => {
  e.preventDefault();
  const errEl  = document.getElementById("modal-error");
  const submit = document.getElementById("modal-submit");
  errEl.hidden = true; submit.disabled = true; submit.textContent = "Signing in…";
  try {
    const res  = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("modal-username").value.trim(),
        password: document.getElementById("modal-password").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    if (data.role !== "admin") throw new Error("Not an admin account");

    CDM_TOKEN = data.token; CDM_ROLE = "admin";
    localStorage.setItem("cdm_token", CDM_TOKEN);
    adminModal.hidden = true;
    document.getElementById("modal-username").value = "";
    document.getElementById("modal-password").value = "";
    applyAdminUI();
    // Reconnect with admin token
    if (ws) ws.close();
  } catch (err) {
    errEl.textContent = err.message; errEl.hidden = false;
  } finally {
    submit.disabled = false; submit.textContent = "Sign in as Admin";
  }
});

// ===== Boot =====
(async () => {
  await tryRestoreAdmin();
  applyAdminUI();
  connect();
})();
