// ============================================================================
// Live Map — sensors, typed drone fleet, wildfires + water emergencies.
// Both fire and water alerts share the same verification pipeline:
//   sensor → pending → drone scan → confirmed (alert) or false-alarm → fade.
// ============================================================================

// ---------- Map ----------
const map = L.map("map", {
  center: CONFIG.map.center,
  zoom: CONFIG.map.zoom,
  zoomControl: true,
  scrollWheelZoom: true,
});

L.tileLayer(CONFIG.map.tile.url, {
  maxZoom: CONFIG.map.tile.maxZoom,
  attribution: CONFIG.map.tile.attribution,
  subdomains: CONFIG.map.tile.subdomains,
}).addTo(map);

// ---------- Layers ----------
const floodMarkerLayer = L.layerGroup().addTo(map);
const floodRadiusLayer = L.layerGroup().addTo(map);
const waterEmergencyLayer = L.layerGroup().addTo(map);
const fireLayer = L.layerGroup().addTo(map);
const forestSensorMarkerLayer = L.layerGroup().addTo(map);
const forestSensorRadiusLayer = L.layerGroup().addTo(map);
const droneRangeLayer = L.layerGroup().addTo(map);

// ---------- Activity log ----------
const logEl = document.getElementById("activity-log");

function log(message, kind = "info") {
  const empty = logEl.querySelector(".log-empty");
  if (empty) empty.remove();
  const li = document.createElement("li");
  li.className = `log-entry ${kind}`;
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  li.innerHTML = `<span class="log-time">${time}</span> ${message}`;
  logEl.prepend(li);
  while (logEl.children.length > 50) logEl.lastChild.remove();
}

// ---------- Emergency markers (fire + water share a model) ----------
const wildfires = [];
const waterEmergencies = [];

function fireIcon(status) {
  return L.divIcon({
    className: `marker-icon fire ${status}`,
    html: "<span>△</span>",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function waterIcon(status) {
  return L.divIcon({
    className: `marker-icon water ${status}`,
    html: "<span>≈</span>",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

const STATUS_LABELS = {
  fire: {
    pending: "Pending drone scan",
    scanning: "Drone scanning…",
    confirmed: "✓ Confirmed wildfire — agencies notified",
    "false-alarm": "✗ False alarm",
  },
  water: {
    pending: "Pending drone scan",
    scanning: "Drone scanning…",
    confirmed: "✓ Confirmed flood — agencies notified",
    "false-alarm": "✗ False alarm",
  },
};

function emergencyPopup(em) {
  const labels = STATUS_LABELS[em.type];
  return (
    `<strong>${em.name}</strong><br>${labels[em.status] || em.status}` +
    (em.note ? `<br><em>${em.note}</em>` : "")
  );
}

function createEmergency({ type, name, lat, lng, status, note }) {
  const iconFn = type === "water" ? waterIcon : fireIcon;
  const layer = type === "water" ? waterEmergencyLayer : fireLayer;
  const em = {
    type, name, lat, lng, status, note,
    layer,
    removeAt: null,
    fading: false,
    marker: L.marker([lat, lng], { icon: iconFn(status) }).addTo(layer),
  };
  em.refresh = () => {
    em.marker.setIcon(iconFn(em.status));
    em.marker.setPopupContent(emergencyPopup(em));
  };
  em.marker.bindPopup(emergencyPopup(em));
  return em;
}

function addWildfire(opts) {
  const fire = createEmergency({ type: "fire", status: "pending", ...opts });
  wildfires.push(fire);
  return fire;
}

function addWaterEmergency(opts) {
  const we = createEmergency({ type: "water", status: "pending", ...opts });
  waterEmergencies.push(we);
  return we;
}

// ---------- Cleanup / fade-and-remove ----------
function scheduleRemoval(em) {
  const retention =
    em.status === "confirmed"
      ? CONFIG.cleanup.confirmedRetentionMs
      : CONFIG.cleanup.falseAlarmRetentionMs;
  em.removeAt = Date.now() + retention;
}

function fadeAndRemove(em, array) {
  em.fading = true;
  if (em.marker._icon) em.marker._icon.classList.add("fade-out");
  setTimeout(() => {
    em.layer.removeLayer(em.marker);
    const idx = array.indexOf(em);
    if (idx >= 0) array.splice(idx, 1);
  }, CONFIG.cleanup.fadeMs);
}

setInterval(() => {
  const now = Date.now();
  for (const f of wildfires) {
    if (!f.fading && f.removeAt && now >= f.removeAt) fadeAndRemove(f, wildfires);
  }
  for (const w of waterEmergencies) {
    if (!w.fading && w.removeAt && now >= w.removeAt) fadeAndRemove(w, waterEmergencies);
  }
}, 500);

// ---------- Flood sensors ----------
const floodSensors = [];

CONFIG.floodLocations.forEach((loc) => {
  const s = new FloodSensor(loc);
  s.addToLayer(floodMarkerLayer, floodRadiusLayer);
  floodSensors.push(s);
  setTimeout(
    () => floodSensorLoop(s),
    Math.random() * CONFIG.floodSensor.detectionIntervalMs
  );
});

function floodSensorLoop(sensor) {
  if (!sensorMeshEnabled) {
    setTimeout(() => floodSensorLoop(sensor), CONFIG.floodSensor.detectionIntervalMs);
    return;
  }
  const detection = sensor.poll();
  if (detection) {
    const we = addWaterEmergency({
      name: `${sensor.id} alert`,
      lat: detection.lat,
      lng: detection.lng,
      note: `Detected by ${sensor.id} (${sensor.name})`,
    });
    document.getElementById("filter-flood").checked = true;
    if (!map.hasLayer(waterEmergencyLayer)) waterEmergencyLayer.addTo(map);
    dispatchDrone(we);
  }
  setTimeout(() => floodSensorLoop(sensor), CONFIG.floodSensor.detectionIntervalMs);
}

// Idle drain (slow, time-based)
let lastBatteryTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastBatteryTick) / 1000;
  lastBatteryTick = now;
  floodSensors.forEach((s) => s.drainIdle(dt));
}, 1000);

// ---------- Forest sensor mesh ----------
const forestSensors = [];

function buildForestMesh() {
  const regions = CONFIG.forestRegions;
  const jitter = CONFIG.forestSensor.placementJitterDeg;
  for (let i = 0; i < CONFIG.forestSensor.count; i++) {
    const region = regions[i % regions.length];
    const lat = region.lat + (Math.random() - 0.5) * jitter;
    const lng = region.lng + (Math.random() - 0.5) * jitter;
    const sensor = new ForestSensor(lat, lng, region.name);
    sensor.addToLayer(forestSensorMarkerLayer, forestSensorRadiusLayer);
    forestSensors.push(sensor);
    setTimeout(
      () => forestSensorLoop(sensor),
      Math.random() * CONFIG.forestSensor.detectionIntervalMs
    );
  }
}

function forestSensorLoop(sensor) {
  if (!sensorMeshEnabled) {
    setTimeout(() => forestSensorLoop(sensor), CONFIG.forestSensor.detectionIntervalMs);
    return;
  }
  const detection = sensor.poll();
  if (detection) {
    const fire = addWildfire({
      name: `${sensor.id} alert`,
      lat: detection.lat,
      lng: detection.lng,
      note: `Detected by sensor in ${sensor.regionName}`,
    });
    document.getElementById("filter-fire").checked = true;
    fireLayer.addTo(map);
    dispatchDrone(fire);
  }
  setTimeout(() => forestSensorLoop(sensor), CONFIG.forestSensor.detectionIntervalMs);
}

// ---------- Drone fleet ----------
function droneIcon(d) {
  return L.divIcon({
    className: `marker-icon drone ${d.type}-drone`,
    html: `<span>${d.id}</span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

function rangeColor(type) {
  return type === "water" ? "#4aa3d6" : "#ff8a5b";
}

function pathColor(type) {
  return type === "water" ? "#5fc8e0" : "#ff8a5b";
}

function createDrone(base) {
  const d = {
    id: base.id,
    base,
    type: base.type,
    range: CONFIG.drone.rangeMeters,
    pos: [base.lat, base.lng],
    state: "idle",
    startPos: null,
    endPos: null,
    progress: 0,
    speed: CONFIG.drone.speed,
    scanStart: 0,
    scanDuration: CONFIG.drone.scanDurationMs,
    current: null,
    queue: [],
    battery: CONFIG.drone.battery.initialPct,
    marker: null,
    pathLine: null,
    rangeCircle: null,
  };
  d.marker = L.marker(d.pos, { icon: droneIcon(d), zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup(dronePopup(d));
  d.rangeCircle = L.circle([base.lat, base.lng], {
    radius: d.range,
    color: rangeColor(d.type),
    weight: 1,
    opacity: 0.45,
    fillColor: rangeColor(d.type),
    fillOpacity: 0.05,
    dashArray: "4 6",
    interactive: false,
  }).addTo(droneRangeLayer);
  return d;
}

function dronePopup(d) {
  const typeLabel = d.type === "water" ? "Water response" : "Fire response";
  return (
    `<strong>Drone ${d.id}</strong> · ${typeLabel}<br>` +
    `Base: ${d.base.name}<br>` +
    `State: ${d.state}<br>` +
    `Battery: ${batteryHtml(d.battery)}`
  );
}

const fleet = CONFIG.drone.bases.map(createDrone);

// ---------- Fleet display ----------
const fleetEl = document.getElementById("drone-fleet");

function refreshFleetDisplay() {
  fleetEl.innerHTML = "";
  fleet.forEach((d) => {
    const stateLabels = {
      idle: `Idle at ${d.base.name}`,
      dispatching: `→ ${d.current ? d.current.name : ""}`,
      scanning: `Scanning ${d.current ? d.current.name : ""}`,
      returning: `Returning to ${d.base.name}`,
    };
    const queueText = d.queue.length ? ` · queue ${d.queue.length}` : "";
    const offline = d.battery <= 0 ? " · offline" : "";
    const li = document.createElement("li");
    li.className =
      `fleet-item state-${d.state} type-${d.type}` +
      (d.battery <= 0 ? " offline" : "");
    li.innerHTML =
      `<div class="fleet-row">` +
        `<span class="fleet-id">${d.id}</span>` +
        `<span class="fleet-state">${stateLabels[d.state]}${queueText}${offline}</span>` +
      `</div>` +
      `<div class="fleet-row">${batteryHtml(d.battery)}</div>`;
    fleetEl.appendChild(li);
  });
}

// ---------- Dispatcher ----------
function dispatchDrone(em) {
  const candidates = fleet
    .filter((d) => d.type === em.type)
    .map((d) => ({
      d,
      dist: map.distance([d.base.lat, d.base.lng], [em.lat, em.lng]),
    }))
    .filter(
      (x) =>
        x.dist <= x.d.range &&
        x.d.battery > CONFIG.drone.minBatteryToDispatchPct
    )
    .sort((a, b) => a.dist - b.dist);

  const kindLabel = em.type === "water" ? "Water emergency" : "Wildfire";

  if (candidates.length === 0) {
    log(
      `⚠ ${kindLabel} at <strong>${em.name}</strong> — no drone available (out of range or low battery).`,
      "deny"
    );
    // Don't leave it pulsing forever; let it fade like a false alarm.
    em.removeAt = Date.now() + CONFIG.cleanup.falseAlarmRetentionMs;
    return;
  }

  const idle = candidates.find((x) => x.d.state === "idle");
  const chosen = idle
    ? idle.d
    : candidates
        .slice()
        .sort(
          (a, b) =>
            a.d.queue.length - b.d.queue.length || a.dist - b.dist
        )[0].d;

  chosen.queue.push(em);
  log(
    `${kindLabel} reported at <strong>${em.name}</strong>. ` +
      `Drone ${chosen.id} ${idle ? "dispatched" : `queued (#${chosen.queue.length})`}.`
  );
  pumpQueue(chosen);
  refreshFleetDisplay();
}

function pumpQueue(d) {
  if (d.state !== "idle" || d.queue.length === 0) return;
  const em = d.queue.shift();
  d.current = em;
  d.startPos = [...d.pos];
  d.endPos = [em.lat, em.lng];
  d.progress = 0;
  d.state = "dispatching";

  em.status = "pending";
  em.refresh();

  drawPath(d);
  log(`Drone ${d.id} en route to ${em.name}.`);
  refreshFleetDisplay();
}

function drawPath(d) {
  if (d.pathLine) d.pathLine.remove();
  d.pathLine = L.polyline([d.startPos, d.endPos], {
    color: pathColor(d.type),
    weight: 1.5,
    opacity: 0.75,
    dashArray: "4 5",
    interactive: false,
  }).addTo(map);
}

function clearPath(d) {
  if (d.pathLine) {
    d.pathLine.remove();
    d.pathLine = null;
  }
}

function tickDrone(d) {
  // Idle recharge
  if (d.state === "idle" && d.battery < 100) {
    const incr = (CONFIG.drone.battery.rechargePerSecondAtBase * 50) / 1000;
    d.battery = Math.min(100, d.battery + incr);
    if (Math.random() < 0.04) refreshFleetDisplay();
  }

  if (d.state === "dispatching" || d.state === "returning") {
    const oldPos = d.pos;
    d.progress = Math.min(1, d.progress + d.speed);
    const [a0, a1] = d.startPos;
    const [b0, b1] = d.endPos;
    d.pos = [a0 + (b0 - a0) * d.progress, a1 + (b1 - a1) * d.progress];
    d.marker.setLatLng(d.pos);

    const traveledKm = map.distance(oldPos, d.pos) / 1000;
    d.battery = Math.max(0, d.battery - CONFIG.drone.battery.drainPerKm * traveledKm);

    if (d.progress >= 1) {
      if (d.state === "dispatching") {
        d.state = "scanning";
        d.scanStart = Date.now();
        d.current.status = "scanning";
        d.current.refresh();
        clearPath(d);
        log(`Drone ${d.id} arrived at ${d.current.name}. Scanning.`);
      } else {
        d.state = "idle";
        d.current = null;
        clearPath(d);
        log(`Drone ${d.id} returned to ${d.base.name}.`);
        pumpQueue(d);
      }
      refreshFleetDisplay();
    }
  } else if (d.state === "scanning") {
    if (Date.now() - d.scanStart >= d.scanDuration) {
      d.battery = Math.max(0, d.battery - CONFIG.drone.battery.drainPerScan);
      const confirmed = Math.random() < CONFIG.drone.confirmProbability;
      const em = d.current;
      const kind = em.type === "water" ? "flood" : "wildfire";
      const confirmKind = em.type === "water" ? "water-confirm" : "confirm";
      if (confirmed) {
        em.status = "confirmed";
        em.refresh();
        scheduleRemoval(em);
        log(
          `✓ Drone ${d.id} <strong>CONFIRMED</strong> ${kind} at ${em.name}. Emergency services notified.`,
          confirmKind
        );
      } else {
        em.status = "false-alarm";
        em.refresh();
        scheduleRemoval(em);
        log(`✗ Drone ${d.id}: false alarm at ${em.name}.`, "deny");
      }
      d.state = "returning";
      d.startPos = [...d.pos];
      d.endPos = [d.base.lat, d.base.lng];
      d.progress = 0;
      drawPath(d);
      refreshFleetDisplay();
    }
  }

  d.marker.setPopupContent(dronePopup(d));
}

setInterval(() => fleet.forEach(tickDrone), 50);

// ---------- Filters ----------
function bindFilter(id, layers) {
  document.getElementById(id).addEventListener("change", (e) => {
    layers.forEach((layer) => {
      if (e.target.checked) layer.addTo(map);
      else map.removeLayer(layer);
    });
  });
}

bindFilter("filter-flood", [floodMarkerLayer, floodRadiusLayer, waterEmergencyLayer]);
bindFilter("filter-fire", [fireLayer]);
bindFilter("filter-forest-sensor", [forestSensorMarkerLayer, forestSensorRadiusLayer]);
bindFilter("filter-drone-range", [droneRangeLayer]);

// ---------- Add-wildfire flow ----------
const addBtn = document.getElementById("add-wildfire-btn");
let placingFire = false;
let counter = 1;

addBtn.addEventListener("click", () => {
  placingFire = !placingFire;
  if (placingFire) {
    addBtn.textContent = "Cancel — click map to place";
    addBtn.classList.add("active");
    map.getContainer().classList.add("placing");
  } else {
    addBtn.textContent = "Click map to add";
    addBtn.classList.remove("active");
    map.getContainer().classList.remove("placing");
  }
});

map.on("click", (e) => {
  if (!placingFire) return;
  const fire = addWildfire({
    name: `Manual report #${counter++}`,
    lat: e.latlng.lat,
    lng: e.latlng.lng,
    note: "User-reported",
  });
  document.getElementById("filter-fire").checked = true;
  fireLayer.addTo(map);

  placingFire = false;
  addBtn.textContent = "Click map to add";
  addBtn.classList.remove("active");
  map.getContainer().classList.remove("placing");

  dispatchDrone(fire);
});

// ---------- Sensor mesh toggle ----------
const meshToggle = document.getElementById("mesh-toggle");
let sensorMeshEnabled = meshToggle.checked;

meshToggle.addEventListener("change", (e) => {
  sensorMeshEnabled = e.target.checked;
  log(sensorMeshEnabled ? "Sensor mesh enabled." : "Sensor mesh paused.");
});

// ---------- Boot ----------
buildForestMesh();
refreshFleetDisplay();
log(
  `System online. ${fleet.filter(d => d.type === "fire").length} fire drones, ` +
  `${fleet.filter(d => d.type === "water").length} water drones, ` +
  `${forestSensors.length} forest sensors, ${floodSensors.length} flood sensors.`
);
