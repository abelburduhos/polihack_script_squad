-- Climate Disaster Monitor schema v3
-- Manual sensor placement; sensors communicate via signal stations → server.

-- Migration: drop v1/v2 legacy tables
DROP TABLE IF EXISTS emergencies CASCADE;
DROP TABLE IF EXISTS drones        CASCADE;
DROP TABLE IF EXISTS zones         CASCADE;

-- Drop sensors/readings if from v2 (had zone_id column)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sensors' AND column_name = 'zone_id'
  ) THEN
    DROP TABLE IF EXISTS alarms         CASCADE;
    DROP TABLE IF EXISTS sensor_readings CASCADE;
    DROP TABLE IF EXISTS sensors        CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS signal_stations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  range_m     DOUBLE PRECISION NOT NULL DEFAULT 5000,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sensors (
  id            TEXT PRIMARY KEY,
  station_id    TEXT REFERENCES signal_stations(id) ON DELETE SET NULL,
  type          TEXT NOT NULL CHECK (type IN ('wildfire', 'flood')),
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  battery       REAL DEFAULT 100.0,
  metrics       JSONB,
  alarm_active  BOOLEAN DEFAULT FALSE,
  comm_range_m  REAL DEFAULT 2000,
  last_update   TIMESTAMPTZ,
  installed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: add comm_range_m for databases created before this column existed
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS comm_range_m REAL DEFAULT 2000;

CREATE TABLE IF NOT EXISTS sensor_readings (
  id         BIGSERIAL PRIMARY KEY,
  sensor_id  TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ DEFAULT NOW(),
  metrics    JSONB NOT NULL,
  alarm      BOOLEAN DEFAULT FALSE
);

-- Alarm events — one row per alarm, resolved by weather evaluation.
CREATE TABLE IF NOT EXISTS alarms (
  id               BIGSERIAL PRIMARY KEY,
  sensor_id        TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  ts               TIMESTAMPTZ DEFAULT NOW(),
  type             TEXT NOT NULL,
  metrics_snapshot JSONB,
  verdict          TEXT CHECK (verdict IN ('pending', 'real', 'false_alarm')) DEFAULT 'pending',
  weather_data     JSONB,
  weather_reason   TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id      BIGSERIAL PRIMARY KEY,
  ts      TIMESTAMPTZ DEFAULT NOW(),
  kind    TEXT,
  message TEXT
);

CREATE INDEX IF NOT EXISTS idx_readings_sensor_ts ON sensor_readings(sensor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_sensors_station    ON sensors(station_id);
CREATE INDEX IF NOT EXISTS idx_alarms_sensor_ts   ON alarms(sensor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alarms_pending     ON alarms(verdict) WHERE verdict = 'pending';
CREATE INDEX IF NOT EXISTS idx_events_ts          ON events(ts DESC);
