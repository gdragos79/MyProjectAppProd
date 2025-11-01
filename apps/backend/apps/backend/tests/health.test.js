import request from "supertest";
import app from "../app-lite.js";

describe("Health (test-only app)", () => {
  it("GET /api/health -> 200 { ok: true }", async () => {
    const res = await request(app).get("/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
