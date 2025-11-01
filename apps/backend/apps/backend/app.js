const express = require("express");

const app = express();

// Parse JSON bodies if you add POST routes later
app.use(express.json());

// --- Health endpoint (matches your pipelines) ---
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// You can add other routes here later, e.g.
// app.get("/api/all", ...);
// app.post("/api/form", ...);

module.exports = app;
