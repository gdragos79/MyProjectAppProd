import express from "express";

const app = express();
app.use(express.json());

// Minimal health route for CI tests — no DB
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

export default app;
