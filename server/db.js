const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || "cdm",
  password: process.env.PGPASSWORD || "cdm",
  database: process.env.PGDATABASE || "cdm",
});

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
}

module.exports = {
  pool,
  init,
  query: (text, params) => pool.query(text, params),
};
