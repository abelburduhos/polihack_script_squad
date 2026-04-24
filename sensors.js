// =============================================================================
// Sensors — forest mesh + flood sensors. Both are small dots with battery state
// that periodically poll for events within their detection radius.
// =============================================================================

function batteryColorRamp(pct, baseColor = "#3ec48b") {
  if (pct <= 0) return "#3b3f47";
  if (pct < 20) return "#ff5b3b";
  if (pct < 50) return "#ffb340";
  return baseColor;
}

function batteryHtml(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const color = batteryColorRamp(p);
  return (
    `<span class="battery">` +
      `<span class="battery-bar"><span class="battery-fill" style="width:${p}%; background:${color}"></span></span>` +
      `<span class="battery-text">${Math.round(p)}%</span>` +
    `</span>`
  );
}

// Random point within a sensor's detection radius (uniform over area).
function randomPointInRadius(lat, lng, radiusMeters) {
  const angle = Math.random() * Math.PI * 2;
  const distMeters = Math.sqrt(Math.random()) * radiusMeters;
  const dLat = (distMeters / 111000) * Math.cos(angle);
  const dLng =
    (distMeters / (111000 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle);
  return { lat: lat + dLat, lng: lng + dLng };
}

// ----- Forest sensor -----
class ForestSensor {
  static nextId = 1;

  constructor(lat, lng, regionName) {
    this.id = `FS-${String(ForestSensor.nextId++).padStart(3, "0")}`;
    this.lat = lat;
    this.lng = lng;
    this.regionName = regionName;
    this.battery = CONFIG.forestSensor.battery.initialPct;

    this.marker = L.circleMarker([lat, lng], {
      radius: 5,
      color: "#0a0e14",
      weight: 1.5,
      fillColor: batteryColorRamp(this.battery),
      fillOpacity: 0.95,
    });

    this.radius = L.circle([lat, lng], {
      radius: CONFIG.forestSensor.detectionRadiusMeters,
      color: "#3ec48b",
      weight: 1,
      opacity: 0.18,
      fillColor: "#3ec48b",
      fillOpacity: 0.05,
      interactive: false,
    });

    this.marker.bindTooltip(this.tooltip(), { direction: "top", offset: [0, -4] });
    this.marker.bindPopup(this.popup());
  }

  tooltip() { return `${this.id} · ${Math.round(this.battery)}%`; }

  popup() {
    const status = this.battery > 0 ? "Online" : "Offline";
    return (
      `<strong>${this.id}</strong><br>` +
      `Forest sensor — ${this.regionName}<br>` +
      `Status: ${status}<br>` +
      `Battery: ${batteryHtml(this.battery)}`
    );
  }

  refreshVisual() {
    this.marker.setStyle({ fillColor: batteryColorRamp(this.battery) });
    this.marker.setTooltipContent(this.tooltip());
    this.marker.setPopupContent(this.popup());
  }

  drainOnCheck() {
    if (this.battery <= 0) return;
    this.battery = Math.max(0, this.battery - CONFIG.forestSensor.battery.drainPerCheck);
    this.refreshVisual();
  }

  isAlive() { return this.battery > 0; }

  poll() {
    if (!this.isAlive()) return null;
    this.drainOnCheck();
    if (Math.random() < CONFIG.forestSensor.detectionProbabilityPerCheck) {
      return randomPointInRadius(this.lat, this.lng, CONFIG.forestSensor.detectionRadiusMeters);
    }
    return null;
  }

  addToLayer(markerLayer, radiusLayer) {
    this.marker.addTo(markerLayer);
    this.radius.addTo(radiusLayer);
  }
}

// ----- Flood / water sensor -----
class FloodSensor {
  static nextId = 1;

  constructor({ name, lat, lng, note }) {
    this.id = `WS-${String(FloodSensor.nextId++).padStart(3, "0")}`;
    this.name = name;
    this.lat = lat;
    this.lng = lng;
    this.note = note;
    this.battery = CONFIG.floodSensor.battery.initialPct;

    this.marker = L.circleMarker([lat, lng], {
      radius: 5,
      color: "#0a0e14",
      weight: 1.5,
      fillColor: batteryColorRamp(this.battery, "#4aa3d6"),
      fillOpacity: 0.95,
    });

    this.radius = L.circle([lat, lng], {
      radius: CONFIG.floodSensor.detectionRadiusMeters,
      color: "#4aa3d6",
      weight: 1,
      opacity: 0.2,
      fillColor: "#4aa3d6",
      fillOpacity: 0.06,
      interactive: false,
    });

    this.marker.bindTooltip(this.tooltip(), { direction: "top", offset: [0, -4] });
    this.marker.bindPopup(this.popup());
  }

  tooltip() { return `${this.id} · ${this.name} · ${Math.round(this.battery)}%`; }

  popup() {
    const status = this.battery > 0 ? "Online" : "Offline";
    return (
      `<strong>${this.id} — ${this.name}</strong><br>` +
      `Flood sensor — ${this.note}<br>` +
      `Status: ${status}<br>` +
      `Battery: ${batteryHtml(this.battery)}`
    );
  }

  refreshVisual() {
    this.marker.setStyle({ fillColor: batteryColorRamp(this.battery, "#4aa3d6") });
    this.marker.setTooltipContent(this.tooltip());
    this.marker.setPopupContent(this.popup());
  }

  drainOnCheck() {
    if (this.battery <= 0) return;
    this.battery = Math.max(0, this.battery - CONFIG.floodSensor.battery.drainPerCheck);
    this.refreshVisual();
  }

  drainIdle(deltaSec) {
    if (this.battery <= 0) return;
    this.battery = Math.max(
      0,
      this.battery - CONFIG.floodSensor.battery.drainPerSecond * deltaSec
    );
    this.refreshVisual();
  }

  isAlive() { return this.battery > 0; }

  poll() {
    if (!this.isAlive()) return null;
    this.drainOnCheck();
    if (Math.random() < CONFIG.floodSensor.detectionProbabilityPerCheck) {
      return randomPointInRadius(this.lat, this.lng, CONFIG.floodSensor.detectionRadiusMeters);
    }
    return null;
  }

  addToLayer(markerLayer, radiusLayer) {
    this.marker.addTo(markerLayer);
    this.radius.addTo(radiusLayer);
  }
}
