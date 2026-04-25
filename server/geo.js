// Geometry helpers and zone hex-fill.

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Hex grid filling a circular zone. Each cell sits at a sensor center;
// spacing = sensorRadiusM * factor. Returns [{lat, lng}, ...] inside zone.
function hexFillZone({ centerLat, centerLng, zoneRadiusM, sensorRadiusM, spacingFactor = 1.6 }) {
  const points = [];
  const spacingM = sensorRadiusM * spacingFactor;
  const latPerM = 1 / 111000;
  const lngPerM = 1 / (111000 * Math.cos((centerLat * Math.PI) / 180));
  const dLat = spacingM * latPerM;
  const dLng = spacingM * lngPerM;
  const rowDLat = dLat * Math.sqrt(3) / 2; // hex row vertical step

  const rows = Math.ceil(zoneRadiusM / (spacingM * Math.sqrt(3) / 2)) + 1;
  const cols = Math.ceil(zoneRadiusM / spacingM) + 1;

  for (let r = -rows; r <= rows; r++) {
    const rowOffset = (r % 2 === 0 ? 0 : dLng / 2);
    for (let c = -cols; c <= cols; c++) {
      const lat = centerLat + r * rowDLat;
      const lng = centerLng + c * dLng + rowOffset;
      if (haversineMeters(lat, lng, centerLat, centerLng) <= zoneRadiusM) {
        points.push({ lat, lng });
      }
    }
  }
  return points;
}

module.exports = {
  haversineMeters,
  hexFillZone,
};
