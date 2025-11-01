import pg from 'pg';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';

const { Client } = pg;

const DB_USER = process.env.DB_USER || 'postgres';
const DB_HOST = process.env.DB_HOST || 'db';
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD || '1234';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);

const client = new Client({
  user: DB_USER,
  host: DB_HOST,
  database: DB_NAME,
  password: DB_PASSWORD,
  port: DB_PORT,
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

async function ensureUsersTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      age INTEGER NOT NULL CHECK (age >= 0)
    );
  `);
}

async function start() {
  let retries = 10;
  while (retries) {
    try {
      await client.connect();
      break;
    } catch (err) {
      console.error('DB connection failed, retrying in 3s...', err.message);
      retries -= 1;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (!retries) {
    console.error('Could not connect to the database. Exiting.');
    process.exit(1);
  }

  await ensureUsersTable();

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, db: { host: DB_HOST, name: DB_NAME }});
  });

  app.get('/api/all', async (req, res) => {
    try {
      const { rows } = await client.query('SELECT id, name, email, age FROM users ORDER BY id DESC;');
      res.json(rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/form', async (req, res) => {
    try {
      const { name, email, age } = req.body;
      const { rows } = await client.query(
        'INSERT INTO users(name, email, age) VALUES ($1, $2, $3) RETURNING id, name, email, age;',
        [name, email, parseInt(age, 10)]
      );
      res.status(201).json(rows[0]);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  const PORT = parseInt(process.env.PORT || '3000', 10);
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}.`));
}

start().catch(err => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
