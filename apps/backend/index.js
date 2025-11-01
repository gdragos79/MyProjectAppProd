// apps/backend/index.js
const express = require('express');
const cors = require('cors');
const { Client } = require('pg');

const app = express();
app.use(express.json());
app.use(cors());

// Fixed default; CI sets PORT=3000 explicitly
const PORT = parseInt(process.env.PORT || '3000', 10);

// Simple health endpoints (both variants, per your project history)
app.get(['/api/health', '/health'], (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Optional DB probe. It NEVER crashes the app if DB is missing/unreachable.
app.get(['/api/db', '/db'], async (req, res) => {
  const { DB_HOST, DB_PORT = '5432', DB_USER, DB_PASSWORD, DB_NAME } = process.env;

  if (!DB_HOST || !DB_USER || !DB_NAME) {
    return res.status(200).json({ db: 'skipped', reason: 'missing DB_* envs' });
  }

  const client = new Client({
    host: DB_HOST,
    port: parseInt(DB_PORT, 10),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    ssl: false
  });

  try {
    await client.connect();
    const r = await client.query('SELECT 1 AS ok');
    await client.end();
    res.json({ db: 'ok', result: r.rows[0] });
  } catch (err) {
    res.status(500).json({ db: 'error', message: err.message });
  }
});

// Start server — log a clear line the workflow can “see”
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend listening on http://127.0.0.1:${PORT}`);
});
