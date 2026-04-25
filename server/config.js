module.exports = {
  wildfireSensor: {
    detectionRadiusMeters: 300,
    commRangeMeters: 2000,
    readingIntervalMs: 4000,
    battery: { initialPct: 100, drainPerReading: 0.005 },
    alarmThresholds: {
      smokeIndex:  0.6,
      tempC:       35,
      humidityPct: 20,
      co2Ppm:      700,
    },
  },

  floodSensor: {
    detectionRadiusMeters: 800,
    commRangeMeters: 2000,
    readingIntervalMs: 5000,
    battery: { initialPct: 100, drainPerReading: 0.005 },
    alarmThresholds: {
      levelCm:  600,
      flowM3s:  2000,
    },
  },

  station: {
    defaultRangeM: 5000,
    minRangeM:     500,
    maxRangeM:     50000,
  },

  history: {
    persistEveryMs: 30000,
  },
};
