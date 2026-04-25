const path = require("path");
const fs   = require("fs");
const http = require("http");
const url  = require("url");
const express = require("express");
const { WebSocketServer } = require("ws");

const db   = require("./db");
const seed = require("./seed");
const sim  = require("./sim");
const auth = require("./auth");

// Load .env if present
try {
  fs.readFileSync(path.join(__dirname, "../.env"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .forEach((l) => {
      const idx = l.indexOf("=");
      if (idx < 0) return;
      const k = l.slice(0, idx).trim();
      const v = l.slice(idx + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    });
} catch {}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  const session = auth.verify(token);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== "admin")
    return res.status(403).json({ error: "Admin required" });
  next();
}

async function main() {
  await db.init();
  await seed.seedIfEmpty();

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  // ----- Auth -----
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};
    const result = auth.login(username, password);
    if (!result) return res.status(401).json({ error: "Invalid credentials" });
    res.json(result);
  });

  app.get("/api/me", requireAuth, (req, res) => {
    res.json({ username: req.session.username, role: req.session.role });
  });

  // ----- Read-only (auth required) -----
  app.get("/api/snapshot", requireAuth, (_req, res) => res.json(sim.buildSnapshot()));
  app.get("/api/health",   (_req, res) => res.json({ ok: true }));

  // ----- Admin-only write endpoints -----
  app.post("/api/stations", requireAuth, requireAdmin, async (req, res) => {
    const { name, lat, lng, rangeM } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number")
      return res.status(400).json({ error: "lat, lng required" });
    try {
      const s = await sim.createStation({ name, lat, lng, rangeM });
      res.json({ id: s.id });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete("/api/stations/:id", requireAuth, requireAdmin, async (req, res) => {
    const ok = await sim.deleteStation(req.params.id);
    res.json({ ok });
  });

  app.post("/api/sensors", requireAuth, requireAdmin, async (req, res) => {
    const { type, lat, lng, stationId } = req.body || {};
    if (!type || typeof lat !== "number" || typeof lng !== "number")
      return res.status(400).json({ error: "type, lat, lng required" });
    try {
      const s = await sim.createSensor({ type, lat, lng, stationId });
      res.json({ id: s.id });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete("/api/sensors/:id", requireAuth, requireAdmin, async (req, res) => {
    const ok = await sim.deleteSensor(req.params.id);
    res.json({ ok });
  });

  // ----- WebSocket -----
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server, clientTracking: false });

  wss.on("connection", (ws, request) => {
    // Token passed as query param: ws://host?token=xxx
    // No token = connect as viewer (read-only)
    const qs      = url.parse(request.url, true).query;
    const session = auth.verify(qs.token);

    ws.role     = session ? session.role     : "client";
    ws.username = session ? session.username : "viewer";

    sim.attachClient(ws);
    ws.send(JSON.stringify({ type: "snapshot", data: sim.buildSnapshot() }));
    ws.send(JSON.stringify({ type: "auth", role: ws.role, username: ws.username }));

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Read-only ops allowed for everyone
      // Write ops: admin only
      const isWrite = ["station:create","station:delete","sensor:create","sensor:delete"].includes(msg.type);
      if (isWrite && ws.role !== "admin") {
        ws.send(JSON.stringify({ type: "error", message: "Admin access required" }));
        return;
      }

      switch (msg.type) {
        case "station:create":
          sim.createStation({ name: msg.name, lat: msg.lat, lng: msg.lng, rangeM: msg.rangeM })
            .catch((err) => ws.send(JSON.stringify({ type: "error", message: err.message })));
          break;
        case "station:delete":
          sim.deleteStation(msg.id).catch(console.error);
          break;
        case "sensor:create":
          sim.createSensor({ type: msg.sensorType, lat: msg.lat, lng: msg.lng, stationId: msg.stationId || null })
            .catch((err) => ws.send(JSON.stringify({ type: "error", message: err.message })));
          break;
        case "sensor:delete":
          sim.deleteSensor(msg.id).catch(console.error);
          break;
        case "sensor:update_range":
          if (ws.role !== "admin") {
            ws.send(JSON.stringify({ type: "error", message: "Admin required" }));
            break;
          }
          sim.updateSensorRange(msg.id, msg.commRangeM).catch(console.error);
          break;
      }
    });

    ws.on("close", () => sim.detachClient(ws));
  });

  await sim.start();

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, () => {
    console.log(`Climate Disaster Monitor — http://localhost:${PORT}`);
    if (!process.env.WEATHER_API_KEY) {
      console.log("[weather] WEATHER_API_KEY not set — alarms will default to REAL verdict");
    }
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
