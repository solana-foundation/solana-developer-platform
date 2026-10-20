/**
 * Health route tests
 */

import {
  EGRESS_READINESS_SERVES_TRAFFIC,
  EGRESS_READINESS_STATES,
  type EgressReadiness,
} from "@sdp/types/health";
import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { app } from "@/index";
import { env } from "@/test/helpers/env";

function appWithEgress(readiness: EgressReadiness) {
  return createApp({
    rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
    egressReadiness: () => readiness,
  });
}

describe("Health routes", () => {
  describe("GET /health", () => {
    it("returns ok status", async () => {
      const res = await app.request("/health", {}, env);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        status: string;
        version: string;
        environment: string;
        releaseChannel: string;
        timestamp: string;
      };
      expect(body.status).toBe("ok");
      expect(body.version).toBe("v1");
      expect(body.environment).toBe("development");
      expect(body.releaseChannel).toBe("experimental");
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
        commit: string;
        checks: { database: string; redis: string };
      };
      expect(body.status).toBe("ready");
      expect(body.revision).toBe("local");
      expect(body.commit).toBe("local");
      expect(body.checks.database).toBe("ok");
      expect(body.checks.redis).toBe("ok");
    });

    it("reports the commit the serving image was built from", async () => {
      const commit = "0123456789abcdef0123456789abcdef01234567";
      const res = await app.request("/health/ready", {}, { ...env, SDP_BUILD_SHA: `${commit}\n` });

      await expect(res.json()).resolves.toMatchObject({ commit });
    });

    it("returns not ready when Redis is unavailable", async () => {
      const res = await app.request("/health/ready", {}, { ...env, REDIS_URL: undefined });

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        status: "not_ready",
        checks: { database: "ok", redis: "error" },
      });
    });

    it("omits the egress check where nothing gates on egress", async () => {
      const res = await app.request("/health/ready", {}, env);

      await expect(res.json()).resolves.not.toHaveProperty("checks.egress");
    });

    it("keeps a fresh instance out of rotation while egress is pending", async () => {
      const res = await appWithEgress("pending").request("/health/ready", {}, env);

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        status: "not_ready",
        checks: { database: "ok", redis: "ok", egress: "pending" },
      });
    });

    it.each(EGRESS_READINESS_STATES.filter((state) => EGRESS_READINESS_SERVES_TRAFFIC[state]))(
      "reports ready once egress is %s",
      async (egress) => {
        const res = await appWithEgress(egress).request("/health/ready", {}, env);

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({
          status: "ready",
          checks: { database: "ok", redis: "ok", egress },
        });
      }
    );
  });
});
