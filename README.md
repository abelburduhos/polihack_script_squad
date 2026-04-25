# Climate Disaster Monitor

Backend-driven simulation of a Romanian climate-disaster monitoring network: a forest sensor mesh detects wildfires, water sensors along major rivers detect flood events, and a fleet of typed drones (fire vs. water) verifies each alert before emergency services are notified.

## Architecture

- **Frontend** — `public/`: static HTML/CSS/JS. Leaflet for the map, Three.js for the home-page globe. No simulation runs here — it only renders state from the server.
- **Backend** — `server/`: Node.js + Express + WebSocket (`ws`). Owns the simulation tick (drone movement, sensor polling), persists everything to PostgreSQL, and broadcasts live state changes to all connected clients.
- **Database** — PostgreSQL 16. Tables: `sensors`, `drones`, `emergencies`, `events`. Schema in [server/schema.sql](server/schema.sql).

## Running

You need **Node 20+** and **Docker**.

```bash
# 1. Start PostgreSQL
docker compose up -d

# 2. Install backend deps
cd server
npm install

# 3. Start the server (auto-creates schema, seeds sensors and drones)
npm start
```

Then open <http://localhost:3000>.

## What gets seeded

On first boot the server seeds:

- **Forest sensors** uniformly across rough Transylvanian forest polygons (Apuseni, Eastern Carpathians, Southern Carpathians), excluding city buffers. Roughly 30–40 sensors at ~33 km grid spacing.
- **Water sensors** along major rivers (Danube, Mureș, Olt, Someș, Tisza, Prut, Siret), every 40 km along each path.
- **Drones** at strategic forest centroids and river junctions — never at cities. Each drone has a 25 km action radius (configurable in [server/config.js](server/config.js)).

To re-seed from scratch:

```bash
docker compose down -v        # wipes the postgres volume
docker compose up -d
```

## Configuration

- **Simulation knobs** (drone speed, range, battery, sensor radii, intervals, retention windows): [server/config.js](server/config.js)
- **Geographic data** (forest polygons, river waypoints, city exclusions, drone bases): [server/geo.js](server/geo.js)
- **Frontend / map UI** (tile layer, default zoom, globe behaviour): [public/ui-config.js](public/ui-config.js)
- **Database connection** via environment variables — see [server/.env.example](server/.env.example).

## REST endpoints

- `GET /api/health` — liveness check
- `GET /api/snapshot` — full current world state as JSON
- `POST /api/wildfire` — file a manual wildfire report
  ```json
  { "lat": 45.6, "lng": 24.7, "name": "Test report" }
  ```

## WebSocket protocol

Clients connect to the server's HTTP port. On connect they receive a `snapshot`, then live deltas:

| Message                | Direction       | Payload                              |
|------------------------|-----------------|--------------------------------------|
| `snapshot`             | server → client | full world state                     |
| `drone:update`         | server → client | drone position, state, battery       |
| `sensor:update`        | server → client | sensor battery                       |
| `emergency:new`        | server → client | new pending emergency                |
| `emergency:update`     | server → client | status / removeAt change             |
| `emergency:remove`     | server → client | id to remove                         |
| `log`                  | server → client | activity log entry                   |
| `mesh:state`           | server → client | sensor mesh enable/disable           |
| `report:wildfire`      | client → server | manual wildfire report               |
| `mesh:set`             | client → server | toggle the sensor mesh               |
