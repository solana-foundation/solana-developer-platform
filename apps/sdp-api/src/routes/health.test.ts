/**
 * Health route tests
 */

import { describe, expect, it } from "vitest";
import app from "@/index";
import { env } from "@/test/helpers/env";

describe("Health routes", () => {
  describe("GET /health", () => {
    it("returns ok status", async () => {
      const res = await app.request("/health", {}, env);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        status: string;
        version: string;
        environment: string;
        timestamp: string;
      };
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

      const body = (await res.json()) as {
        status: string;
        checks: { database: string };
      };
      expect(body.status).toBe("ready");
      expect(body.checks.database).toBe("ok");
    });
  });
});
