// =============================================================================
// CONFIG — every tunable parameter lives here. Edit values; reload the page.
// =============================================================================
const CONFIG = {
  // -------- Map --------
  map: {
    center: [46.0, 24.5],          // Transylvania-leaning view
    zoom: 7,
    tile: {
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      attribution:
        "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> &copy; <a href='https://carto.com/attributions'>CARTO</a>",
      maxZoom: 19,
      subdomains: "abcd",
    },
  },

  // -------- Drone fleet --------
  // Each drone has a `type`: "fire" or "water". The dispatcher only sends
  // matching drones to a given emergency.
  drone: {
    bases: [
      // Fire drones — Transylvania
      { id: 1,  name: "Apuseni Mountains",     lat: 46.55,   lng: 22.80,   type: "fire"  },
      { id: 2,  name: "Retezat National Park", lat: 45.36,   lng: 22.88,   type: "fire"  },
      { id: 3,  name: "Făgăraș Mountains",     lat: 45.60,   lng: 24.70,   type: "fire"  },
      { id: 4,  name: "Rodna Mountains",       lat: 47.55,   lng: 24.85,   type: "fire"  },
      { id: 5,  name: "Cindrel Mountains",     lat: 45.58,   lng: 23.78,   type: "fire"  },
      { id: 6,  name: "Călimani Mountains",    lat: 47.15,   lng: 25.20,   type: "fire"  },
      // Water drones — co-located with flood sensors
      { id: 7,  name: "Galați station",        lat: 45.4353, lng: 28.0080, type: "water" },
      { id: 8,  name: "Tulcea station",        lat: 45.1667, lng: 28.8000, type: "water" },
      { id: 9,  name: "Timișoara station",     lat: 45.7489, lng: 21.2087, type: "water" },
      { id: 10, name: "Satu Mare station",     lat: 47.7920, lng: 22.8900, type: "water" },
      { id: 11, name: "Oradea station",        lat: 47.0722, lng: 21.9217, type: "water" },
      { id: 12, name: "Brăila station",        lat: 45.2692, lng: 27.9574, type: "water" },
    ],
    rangeMeters: 10000,             // 10 km action radius
    speed: 0.018,                   // progress per 50ms tick (snappier for short trips)
    scanDurationMs: 3000,
    confirmProbability: 0.75,
    minBatteryToDispatchPct: 8,
    battery: {
      initialPct: 100,
      drainPerKm: 0.2,              // tuned so a round trip costs ~5% battery
      drainPerScan: 1.0,
      rechargePerSecondAtBase: 0.5,
    },
  },

  // -------- Forest sensor mesh (Transylvania only) --------
  forestSensor: {
    count: 24,                              // sensors deployed across Transylvania
    detectionRadiusMeters: 5000,            // smaller so fires fall inside drone reach
    detectionIntervalMs: 4000,
    detectionProbabilityPerCheck: 0.005,
    placementJitterDeg: 0.05,               // ~3–4 km around region center
    battery: {
      initialPct: 100,
      drainPerCheck: 0.02,
    },
  },

  // -------- Flood / water sensors (anywhere in Romania) --------
  floodSensor: {
    detectionRadiusMeters: 5000,
    detectionIntervalMs: 6000,
    detectionProbabilityPerCheck: 0.006,
    battery: {
      initialPct: 100,
      drainPerCheck: 0.02,
      drainPerSecond: 0.005,
    },
  },

  // -------- Cleanup / retention --------
  // Confirmed and false-alarm retention apply to both wildfires and water
  // emergencies — both go through the same verification pipeline now.
  cleanup: {
    confirmedRetentionMs: 30000,
    falseAlarmRetentionMs: 10000,
    fadeMs: 800,
  },

  // -------- Forest regions where sensors and fires cluster --------
  // Restricted to Transylvania for now.
  forestRegions: [
    { name: "Apuseni Mountains",     lat: 46.55, lng: 22.80 },
    { name: "Retezat National Park", lat: 45.36, lng: 22.88 },
    { name: "Făgăraș Mountains",     lat: 45.60, lng: 24.70 },
    { name: "Rodna Mountains",       lat: 47.55, lng: 24.85 },
    { name: "Cindrel Mountains",     lat: 45.58, lng: 23.78 },
    { name: "Călimani Mountains",    lat: 47.15, lng: 25.20 },
  ],

  // -------- Flood sensor locations --------
  floodLocations: [
    { name: "Galați",     lat: 45.4353, lng: 28.0080, note: "Danube" },
    { name: "Tulcea",     lat: 45.1667, lng: 28.8000, note: "Danube delta" },
    { name: "Timișoara",  lat: 45.7489, lng: 21.2087, note: "Bega river" },
    { name: "Satu Mare",  lat: 47.7920, lng: 22.8900, note: "Someș river" },
    { name: "Oradea",     lat: 47.0722, lng: 21.9217, note: "Crișul Repede" },
    { name: "Brăila",     lat: 45.2692, lng: 27.9574, note: "Lower Danube" },
  ],

  // -------- Home page globe --------
  home: {
    autoRotateSpeed: 0.0025,
    scrollZoom: 0.9,
    scrollTilt: 0.35,
  },
};
