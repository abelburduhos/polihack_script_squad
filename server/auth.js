// Simple token-based auth. Two roles: admin (full access) and client (read-only).
// Credentials loaded from environment variables.
// Not hardened for public internet exposure — change defaults before deploying.

const crypto = require("crypto");

function users() {
  return {
    [process.env.ADMIN_USER || "admin"]:  { password: process.env.ADMIN_PASS  || "admin",  role: "admin"  },
    [process.env.CLIENT_USER || "viewer"]: { password: process.env.CLIENT_PASS || "viewer", role: "client" },
  };
}

// token → { username, role, expires }
const sessions = new Map();

// Clean expired sessions every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
}, 10 * 60 * 1000);

function login(username, password) {
  const u = users()[username];
  if (!u || u.password !== password) return null;
  const token = crypto.randomBytes(28).toString("hex");
  sessions.set(token, { username, role: u.role, expires: Date.now() + 24 * 60 * 60 * 1000 });
  return { token, role: u.role, username };
}

function verify(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

module.exports = { login, verify };
