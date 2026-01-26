/**
 * Health route tests
 */

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import app from "@/index";

describe("Health routes", () => {
  describe("GET /health", () => {
    it("returns ok status", async () => {
      const res = await app.request("/health", {}, env);

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.version).toBe("v1");
      expect(body.environment).toBe("development");
      expect(body.timestamp).toBeDefined();
    });
  });

  describe("GET /health/ready", () => {
    it("returns ready when database is accessible", async () => {
      const res = await app.request("/health/ready", {}, env);

      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ready");
      expect(body.checks.database).toBe("ok");
    });
  });
});
