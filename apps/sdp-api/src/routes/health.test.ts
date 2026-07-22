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
    it("returns ready when Postgres and Redis are accessible", async () => {
      const res = await app.request("/health/ready", {}, env);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        status: string;
        revision: string;
        checks: { database: string; redis: string };
      };
      expect(body.status).toBe("ready");
      expect(body.revision).toBe("local");
      expect(body.checks.database).toBe("ok");
      expect(body.checks.redis).toBe("ok");
    });

    it("returns not ready when Redis is unavailable", async () => {
      const res = await app.request("/health/ready", {}, { ...env, REDIS_URL: undefined });

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        status: "not_ready",
        checks: { database: "ok", redis: "error" },
      });
    });
  });
});
