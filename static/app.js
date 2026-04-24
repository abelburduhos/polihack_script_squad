// Hazard Response — live dashboard
'use strict';

const byId = (id) => document.getElementById(id);

const FLOOD_TYPES = new Set(['water_level', 'rainfall', 'flow_rate']);
const FIRE_TYPES  = new Set(['smoke', 'temperature', 'humidity']);

// Thresholds — keep in sync with hazards/*.py. warn = ~75% of threshold.
const RULES = {
  water_level: { crit: 3.0, cmp: '>' },
  rainfall:    { crit: 25.0, cmp: '>' },
  flow_rate:   { crit: 80.0, cmp: '>' },
  smoke:       { crit: 400.0, cmp: '>' },
  temperature: { crit: 45.0, cmp: '>' },
  humidity:    { crit: 20.0, cmp: '<' },
};

const state = {
  sensors: [],
  drones: [],
  hazards: [],
  sensorTypes: [],
  townCenter: [45.7489, 21.2087],
  history: new Map(),            // sensor_id -> [values]
  incidents: [],
  mapBounds: null,
  focused: { type: null, id: null },
  dronePrevPos: new Map(),       // drone_id -> [lat,lon] (for trail)
  pickMode: null,                // 'sensor' | 'drone' | null
};

const HIST = 24;

// ── rule evaluation for UI color ────────────────────────────────────────
function evalLevel(type, value) {
  const r = RULES[type]; if (!r) return 'ok';
  if (r.cmp === '>') {
    if (value > r.crit) return 'crit';
    if (value > r.crit * 0.75) return 'warn';
  } else {
    if (value < r.crit) return 'crit';
    if (value < r.crit * 1.3) return 'warn';
  }
  return 'ok';
}
const hazardClass = (t) =>
  FLOOD_TYPES.has(t) ? 'hazard-flood' : (FIRE_TYPES.has(t) ? 'hazard-fire' : '');

// ── map projection ──────────────────────────────────────────────────────
function computeMapBounds() {
  const pts = [
    ...state.sensors.map(s => s.location),
    ...state.drones.map(d => d.home),
    state.townCenter,
  ];
  if (!pts.length) return;
  const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
  const pad = 0.03;
  state.mapBounds = {
    latMin: Math.min(...lats) - pad, latMax: Math.max(...lats) + pad,
    lonMin: Math.min(...lons) - pad, lonMax: Math.max(...lons) + pad,
  };
}
function project(lat, lon) {
  const b = state.mapBounds;
  const x = ((lon - b.lonMin) / (b.lonMax - b.lonMin)) * 1000;
  const y = (1 - (lat - b.latMin) / (b.latMax - b.latMin)) * 700;
  return [x, y];
}
function unproject(x, y) {
  const b = state.mapBounds;
  const lon = b.lonMin + (x / 1000) * (b.lonMax - b.lonMin);
  const lat = b.latMin + (1 - y / 700) * (b.latMax - b.latMin);
  return [lat, lon];
}

const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

// ── rebuild everything spatial (on topology or boot) ────────────────────
function rebuildMap() {
  computeMapBounds();
  const map = byId('map');
  map.innerHTML = '';
  for (let x = 0; x <= 1000; x += 100)
    map.appendChild(svgEl('line', {x1:x, y1:0, x2:x, y2:700, class:'map-grid-line'}));
  for (let y = 0; y <= 700; y += 100)
    map.appendChild(svgEl('line', {x1:0, y1:y, x2:1000, y2:y, class:'map-grid-line'}));

  const [tx, ty] = project(...state.townCenter);
  const tg = svgEl('g');
  tg.appendChild(svgEl('circle', {cx: tx, cy: ty, r: 4, fill:'#ffffff', 'fill-opacity':'0.55'}));
  const lab = svgEl('text', {x: tx + 10, y: ty + 4, class:'drone-label', fill:'rgba(255,255,255,0.5)'});
  lab.textContent = 'center';
  tg.appendChild(lab);
  map.appendChild(tg);

  ['range-layer', 'path-layer', 'sensor-layer', 'drone-layer', 'incident-layer']
    .forEach(id => map.appendChild(svgEl('g', { id })));

  state.sensors.forEach(addSensorToMap);
  state.drones.forEach(addDroneToMap);
}

function addSensorToMap(s) {
  const [x, y] = project(...s.location);
  const color = FLOOD_TYPES.has(s.sensor_type) ? '#38bdf8' : '#fb923c';
  const g = svgEl('g', { id: `s-${s.sensor_id}` });
  g.appendChild(svgEl('circle', { class:'sensor-ring', cx:x, cy:y, r:8, stroke:color }));
  const dot = svgEl('circle', {
    class:'sensor-dot', cx:x, cy:y, r:5, fill:color, 'fill-opacity':0.9,
  });
  dot.addEventListener('click', (e) => { e.stopPropagation(); focusSensor(s.sensor_id); });
  g.appendChild(dot);
  const t = svgEl('text', { x: x + 9, y: y - 7, class:'drone-label' });
  t.textContent = s.sensor_id;
  g.appendChild(t);
  byId('sensor-layer').appendChild(g);
}

function addDroneToMap(d) {
  const [x, y] = project(...d.position);
  // range circle
  const [hx, hy] = project(...d.home);
  // approximate km→svg scale from bounds
  const scale = 1000 / (111 * (state.mapBounds.lonMax - state.mapBounds.lonMin));
  const rRange = d.max_range_km * scale;
  const range = svgEl('circle', {
    id: `r-${d.drone_id}`, class: 'drone-range',
    cx: hx, cy: hy, r: rRange,
  });
  byId('range-layer').appendChild(range);

  // path placeholder
  const path = svgEl('polyline', {
    id: `p-${d.drone_id}`, class: 'drone-path', points: '',
  });
  byId('path-layer').appendChild(path);

  const g = svgEl('g', {
    id: `d-${d.drone_id}`, class: 'drone-marker',
    transform: `translate(${x},${y})`,
  });
  const poly = svgEl('polygon', {
    points: '0,-9 9,0 0,9 -9,0',
    fill: '#a855f7', 'fill-opacity': 0.9,
    stroke: '#c4b5fd', 'stroke-width': 1.5,
  });
  g.appendChild(poly);
  const t = svgEl('text', { x: 13, y: 4, class: 'drone-label' });
  t.textContent = d.drone_id;
  g.appendChild(t);
  g.addEventListener('click', (e) => { e.stopPropagation(); focusDrone(d.drone_id); });
  byId('drone-layer').appendChild(g);
}

function updateMapDrone(d) {
  const el = byId(`d-${d.drone_id}`);
  if (!el) return;
  const [x, y] = project(...d.position);
  el.setAttribute('transform', `translate(${x},${y})`);
  const poly = el.querySelector('polygon');
  const colors = {
    idle:      { fill:'#a855f7', stroke:'#c4b5fd' },
    en_route:  { fill:'#f59e0b', stroke:'#fcd34d' },
    on_site:   { fill:'#ef4444', stroke:'#fca5a5' },
    returning: { fill:'#22d3ee', stroke:'#67e8f9' },
    charging:  { fill:'#64748b', stroke:'#94a3b8' },
  }[d.status] || { fill:'#a855f7', stroke:'#c4b5fd' };
  poly.setAttribute('fill', colors.fill);
  poly.setAttribute('stroke', colors.stroke);

  // trail
  const path = byId(`p-${d.drone_id}`);
  if (!path) return;
  const prev = state.dronePrevPos.get(d.drone_id);
  if (d.status === 'idle') {
    path.setAttribute('points', '');
    state.dronePrevPos.delete(d.drone_id);
  } else {
    const pts = path.getAttribute('points') || '';
    const curStr = `${x.toFixed(1)},${y.toFixed(1)}`;
    if (!prev || prev[0] !== d.position[0] || prev[1] !== d.position[1]) {
      path.setAttribute('points', (pts ? pts + ' ' : '') + curStr);
      state.dronePrevPos.set(d.drone_id, d.position);
    }
  }
}

function flashIncidentOnMap(inc) {
  const layer = byId('incident-layer');
  const [x, y] = project(...inc.location);
  const color = inc.hazard_name === 'flash_flood' ? '#38bdf8' : '#fb923c';
  const g = svgEl('g', { class: 'incident-marker' });
  g.appendChild(svgEl('circle', { cx:x, cy:y, r:26, fill:'none', stroke:color, 'stroke-width':2, 'stroke-opacity':0.6 }));
  g.appendChild(svgEl('circle', { cx:x, cy:y, r:14, fill:color, 'fill-opacity':0.25, stroke:color, 'stroke-width':2 }));
  layer.appendChild(g);
  setTimeout(() => g.remove(), 12000);
  inc.triggering_readings.forEach(r => {
    const node = byId(`s-${r.sensor_id}`);
    if (node) {
      const ring = node.querySelector('.sensor-ring');
      ring.classList.add('pulsing');
      setTimeout(() => ring.classList.remove('pulsing'), 8000);
    }
  });
}

// ── sensor cards ────────────────────────────────────────────────────────
function renderSensorList() {
  const grid = byId('sensor-grid');
  grid.innerHTML = '';
  state.sensors.forEach(s => {
    const card = document.createElement('div');
    card.className = `sensor ${hazardClass(s.sensor_type)}`;
    card.id = `sensor-${s.sensor_id}`;
    card.innerHTML = `
      <button class="del-btn" data-del-sensor="${s.sensor_id}" title="remove">×</button>
      <div class="sensor-head">
        <span class="sensor-id">${s.sensor_id}</span>
        <span class="sensor-type">${s.sensor_type.replace('_', ' ')}</span>
      </div>
      <div class="sensor-value" data-v>—<span class="unit">${s.unit}</span></div>
      <svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" data-spark>
        <polyline fill="none" stroke="currentColor" stroke-width="1.2" points="" />
      </svg>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.del-btn')) return;
      focusSensor(s.sensor_id);
    });
    card.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSensor(s.sensor_id);
    });
    grid.appendChild(card);
    // replay history if any
    const h = state.history.get(s.sensor_id);
    if (h && h.length) {
      updateSensorUI(s, h[h.length - 1]);
    }
  });
  byId('stat-sensors').textContent = state.sensors.length;
}

function updateSensorUI(sensorMeta, value) {
  const card = byId(`sensor-${sensorMeta.sensor_id}`);
  if (!card) return;
  const level = evalLevel(sensorMeta.sensor_type, value);
  card.classList.remove('level-ok', 'level-warn', 'level-crit');
  card.classList.add(`level-${level}`);
  const valEl = card.querySelector('[data-v]');
  valEl.innerHTML = `${value.toFixed(1)}<span class="unit">${sensorMeta.unit}</span>`;
  const color = level === 'crit' ? '#ef4444'
              : level === 'warn' ? '#f59e0b'
              : (FLOOD_TYPES.has(sensorMeta.sensor_type) ? '#38bdf8' : '#fb923c');
  valEl.style.color = color;
  const hist = state.history.get(sensorMeta.sensor_id) || [];
  drawSpark(card.querySelector('[data-spark] polyline'), hist, color);
}

function ingestReading(reading) {
  const sensor = state.sensors.find(s => s.sensor_id === reading.sensor_id);
  if (!sensor) return;
  const hist = state.history.get(reading.sensor_id) || [];
  hist.push(reading.value);
  if (hist.length > HIST) hist.shift();
  state.history.set(reading.sensor_id, hist);
  updateSensorUI(sensor, reading.value);
}

function drawSpark(polyline, values, color) {
  if (!values.length) return;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const step = 100 / Math.max(1, HIST - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = 28 - ((v - min) / range) * 26 - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  polyline.setAttribute('points', pts);
  polyline.setAttribute('stroke', color);
}

// ── drone list ──────────────────────────────────────────────────────────
function renderDroneList() {
  const wrap = byId('drone-list');
  wrap.innerHTML = '';
  state.drones.forEach(d => {
    const el = document.createElement('div');
    el.className = 'drone';
    el.id = `drone-${d.drone_id}`;
    el.innerHTML = `
      <button class="del-btn" data-del-drone="${d.drone_id}" title="remove">×</button>
      <div class="drone-icon">
        <svg viewBox="0 0 24 24"><path d="M12 2L4 6v5c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V6l-8-4z"/></svg>
      </div>
      <div class="drone-body">
        <div class="drone-id">${d.drone_id}</div>
        <div class="drone-meta" data-meta></div>
      </div>
      <span class="drone-status" data-status></span>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.del-btn')) return;
      focusDrone(d.drone_id);
    });
    el.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteDrone(d.drone_id);
    });
    wrap.appendChild(el);
    updateDroneUI(d);
  });
  byId('drone-count').textContent = `${state.drones.length} units`;
  byId('stat-drones').textContent = state.drones.length;
}

function updateDroneUI(d) {
  const idx = state.drones.findIndex(x => x.drone_id === d.drone_id);
  if (idx >= 0) state.drones[idx] = d;
  const el = byId(`drone-${d.drone_id}`);
  if (!el) return;
  const statusEl = el.querySelector('[data-status]');
  statusEl.className = `drone-status ${d.status}`;
  statusEl.textContent = d.status.replace('_', ' ');
  el.querySelector('[data-meta]').textContent =
    `range ${d.max_range_km}km · home ${d.home[0].toFixed(3)}, ${d.home[1].toFixed(3)}`;
  updateMapDrone(d);
}

// ── focus interactions ─────────────────────────────────────────────────
function clearFocus() {
  document.querySelectorAll('.focused').forEach(el => el.classList.remove('focused'));
  document.querySelectorAll('.drone-range.visible').forEach(el => el.classList.remove('visible'));
  document.querySelectorAll('.sensor-ring.focused').forEach(el => el.classList.remove('focused'));
  state.focused = { type: null, id: null };
}
function focusSensor(id) {
  clearFocus();
  state.focused = { type: 'sensor', id };
  byId(`sensor-${id}`)?.classList.add('focused');
  const node = byId(`s-${id}`);
  node?.querySelector('.sensor-ring')?.classList.add('focused');
}
function focusDrone(id) {
  clearFocus();
  state.focused = { type: 'drone', id };
  byId(`drone-${id}`)?.classList.add('focused');
  byId(`r-${id}`)?.classList.add('visible');
}
function focusLocation(lat, lon) {
  // Brief highlight ring at a lat/lon (for incident clicks).
  const [x, y] = project(lat, lon);
  const g = svgEl('g');
  const ring = svgEl('circle', {
    cx: x, cy: y, r: 8, fill: 'none',
    stroke: 'rgba(34,211,238,0.9)', 'stroke-width': 2,
  });
  g.appendChild(ring);
  byId('incident-layer').appendChild(g);
  ring.animate(
    [{ r: 8, opacity: 1 }, { r: 42, opacity: 0 }],
    { duration: 1400, easing: 'ease-out', iterations: 2 }
  );
  setTimeout(() => g.remove(), 3000);
}

// ── incidents ───────────────────────────────────────────────────────────
function addIncident(inc) {
  state.incidents.unshift({ ...inc, receivedAt: Date.now() });
  if (state.incidents.length > 50) state.incidents.pop();
  byId('stat-incidents').textContent = state.incidents.length;
  renderIncidents();
  flashIncidentOnMap(inc);
}

function renderIncidents() {
  const list = byId('incident-list');
  if (!state.incidents.length) {
    list.innerHTML = '<div class="empty">No incidents yet — system nominal.</div>';
    return;
  }
  list.innerHTML = '';
  state.incidents.forEach((inc, idx) => {
    const hi = inc.severity >= 3;
    const threat = inc.vision && inc.vision.threat_level >= 0 ? inc.vision.threat_level : null;
    const time = new Date(inc.receivedAt).toLocaleTimeString();
    const el = document.createElement('div');
    el.className = `incident ${inc.hazard_name}`;
    el.innerHTML = `
      <div class="incident-head">
        <span class="incident-name ${inc.hazard_name}">${inc.hazard_name.replace('_', ' ')}</span>
        <span class="incident-time">${time}</span>
      </div>
      <div class="incident-meta">
        <span class="sev ${hi ? 'high' : ''}">severity ${inc.severity.toFixed(1)}</span>
        <span>at ${inc.location[0].toFixed(3)}, ${inc.location[1].toFixed(3)}</span>
        ${inc.mission ? `<span>drone ${inc.mission.drone_id} ${inc.mission.arrived ? 'arrived' : 'failed'}</span>` : '<span>no drone</span>'}
      </div>
      <div class="incident-readings">
        ${inc.triggering_readings.map(r =>
          `<span class="tag">${r.sensor_id}: ${r.value}${r.unit}</span>`).join('')}
      </div>
      ${inc.vision && inc.vision.summary ? `
        <div class="incident-vision">
          ${threat !== null ? `threat
            <div class="threat-bar"><span style="width:${threat*10}%"></span></div>
            <strong style="margin-left:8px">${threat}/10</strong><br>` : ''}
          ${escapeHtml(inc.vision.summary)}
        </div>` : ''}
    `;
    el.addEventListener('click', () => focusLocation(inc.location[0], inc.location[1]));
    list.appendChild(el);
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

byId('clear-incidents').addEventListener('click', () => {
  state.incidents = [];
  byId('stat-incidents').textContent = '0';
  renderIncidents();
});

// ── forms: add sensor / add drone ───────────────────────────────────────
function populateSensorTypes() {
  const sel = byId('sensor-type');
  sel.innerHTML = '';
  state.sensorTypes.forEach(t => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t.replace('_', ' ');
    sel.appendChild(o);
  });
}

document.querySelectorAll('[data-open-form]').forEach(btn => {
  btn.addEventListener('click', () => {
    const which = btn.dataset.openForm;
    byId(`${which}-form`).hidden = false;
    // seed location with town center if empty
    if (which === 'sensor') {
      byId('sensor-lat').value = byId('sensor-lat').value || state.townCenter[0].toFixed(4);
      byId('sensor-lon').value = byId('sensor-lon').value || state.townCenter[1].toFixed(4);
      byId('sensor-id').focus();
    } else {
      byId('drone-lat').value = byId('drone-lat').value || state.townCenter[0].toFixed(4);
      byId('drone-lon').value = byId('drone-lon').value || state.townCenter[1].toFixed(4);
      byId('drone-id').focus();
    }
  });
});
document.querySelectorAll('[data-close-form]').forEach(btn => {
  btn.addEventListener('click', () => {
    byId(`${btn.dataset.closeForm}-form`).hidden = true;
    setErr(btn.dataset.closeForm, '');
  });
});

function setErr(form, msg) { byId(`${form}-err`).textContent = msg; }

async function addSensor() {
  setErr('sensor', '');
  const payload = {
    sensor_id: byId('sensor-id').value.trim(),
    sensor_type: byId('sensor-type').value,
    location: [parseFloat(byId('sensor-lat').value), parseFloat(byId('sensor-lon').value)],
  };
  if (!payload.sensor_id) return setErr('sensor', 'id required');
  if (Number.isNaN(payload.location[0]) || Number.isNaN(payload.location[1]))
    return setErr('sensor', 'valid lat/lon required');
  const r = await fetch('/api/sensors', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const msg = await r.text();
    return setErr('sensor', msg.slice(0, 120));
  }
  byId('sensor-id').value = '';
  byId('sensor-form').hidden = true;
}

async function addDrone() {
  setErr('drone', '');
  const payload = {
    drone_id: byId('drone-id').value.trim(),
    home: [parseFloat(byId('drone-lat').value), parseFloat(byId('drone-lon').value)],
    max_range_km: parseFloat(byId('drone-range').value) || 30,
  };
  if (!payload.drone_id) return setErr('drone', 'id required');
  if (Number.isNaN(payload.home[0]) || Number.isNaN(payload.home[1]))
    return setErr('drone', 'valid lat/lon required');
  const r = await fetch('/api/drones', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const msg = await r.text();
    return setErr('drone', msg.slice(0, 120));
  }
  byId('drone-id').value = '';
  byId('drone-form').hidden = true;
}

async function deleteSensor(id) {
  const r = await fetch(`/api/sensors/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) console.warn('delete sensor failed');
}
async function deleteDrone(id) {
  const r = await fetch(`/api/drones/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) console.warn('delete drone failed');
}

byId('sensor-add').addEventListener('click', addSensor);
byId('drone-add').addEventListener('click', addDrone);

// ── pick-on-map mode ────────────────────────────────────────────────────
document.querySelectorAll('.map-pick').forEach(btn => {
  btn.addEventListener('click', () => setPickMode(btn.dataset.pick));
});
byId('pick-cancel').addEventListener('click', () => setPickMode(null));

function setPickMode(mode) {
  state.pickMode = mode;
  byId('pick-banner').hidden = !mode;
  byId('map').classList.toggle('picking', !!mode);
  byId('map-hint').textContent = mode ? `placing ${mode}…` : 'live';
}

byId('map').addEventListener('click', (e) => {
  if (!state.pickMode) {
    if (state.focused.id) clearFocus();
    return;
  }
  const svg = byId('map');
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const local = pt.matrixTransform(svg.getScreenCTM().inverse());
  const [lat, lon] = unproject(local.x, local.y);
  const prefix = state.pickMode;
  byId(`${prefix}-lat`).value = lat.toFixed(4);
  byId(`${prefix}-lon`).value = lon.toFixed(4);
  setPickMode(null);
});

// ── SSE stream ──────────────────────────────────────────────────────────
function setLink(ok) {
  byId('link-dot').className = 'dot ' + (ok ? 'ok' : 'err');
  byId('link-text').textContent = ok ? 'live' : 'reconnecting';
}

function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => setLink(true);
  es.onerror = () => setLink(false);
  es.onmessage = (ev) => {
    try { handleEvent(JSON.parse(ev.data)); }
    catch (e) { console.error(e); }
  };
}

function handleEvent(msg) {
  if (msg.type === 'tick') {
    msg.readings.forEach(ingestReading);
    msg.drones.forEach(updateDroneUI);
    byId('last-tick').textContent = new Date(msg.ts * 1000).toLocaleTimeString();
  } else if (msg.type === 'drone') {
    updateDroneUI(msg.drone);
  } else if (msg.type === 'incident') {
    addIncident(msg.incident);
  } else if (msg.type === 'topology') {
    applyTopology(msg.sensors, msg.drones);
  }
}

function applyTopology(sensors, drones) {
  state.sensors = sensors;
  state.drones = drones;
  // prune history for removed sensors
  const ids = new Set(sensors.map(s => s.sensor_id));
  [...state.history.keys()].forEach(k => { if (!ids.has(k)) state.history.delete(k); });
  const dids = new Set(drones.map(d => d.drone_id));
  [...state.dronePrevPos.keys()].forEach(k => { if (!dids.has(k)) state.dronePrevPos.delete(k); });

  rebuildMap();
  renderSensorList();
  renderDroneList();
  if (state.focused.id) {
    const stillExists = state.focused.type === 'sensor'
      ? ids.has(state.focused.id) : dids.has(state.focused.id);
    if (!stillExists) clearFocus();
    else if (state.focused.type === 'sensor') focusSensor(state.focused.id);
    else focusDrone(state.focused.id);
  }
}

// ── bootstrap ───────────────────────────────────────────────────────────
async function bootstrap() {
  const data = await fetch('/api/state').then(r => r.json());
  state.sensors = data.sensors;
  state.drones = data.drones;
  state.hazards = data.hazards;
  state.townCenter = data.town_center;
  state.sensorTypes = data.sensor_types || [];

  populateSensorTypes();
  computeMapBounds();
  rebuildMap();
  renderSensorList();
  renderDroneList();
  byId('stat-hazards').textContent = state.hazards.length;

  connectStream();
}

bootstrap().catch(err => { console.error(err); setLink(false); });
