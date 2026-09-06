import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { applyEphemeralOverrides, getDeploymentMode, isSelfHostedDeployment } from "./runtime-env";

const envWith = (mode: string | undefined): Pick<Env, "SDP_DEPLOYMENT_MODE"> =>
  ({ SDP_DEPLOYMENT_MODE: mode }) as Pick<Env, "SDP_DEPLOYMENT_MODE">;

describe("getDeploymentMode", () => {
  it("defaults to managed when SDP_DEPLOYMENT_MODE is unset", () => {
    expect(getDeploymentMode(envWith(undefined))).toBe("managed");
  });

  it("accepts the documented values", () => {
    expect(getDeploymentMode(envWith("managed"))).toBe("managed");
    expect(getDeploymentMode(envWith("self_hosted"))).toBe("self_hosted");
  });

  it("throws on a typo'd value (selfhosted, no underscore)", () => {
    expect(() => getDeploymentMode(envWith("selfhosted"))).toThrow(
      /Invalid SDP_DEPLOYMENT_MODE.*selfhosted/
    );
  });

  it("throws on any other unknown value", () => {
    expect(() => getDeploymentMode(envWith("hosted"))).toThrow(/Invalid SDP_DEPLOYMENT_MODE/);
    expect(() => getDeploymentMode(envWith(""))).toThrow(/Invalid SDP_DEPLOYMENT_MODE/);
  });
});

describe("isSelfHostedDeployment", () => {
  it("returns false for managed (default)", () => {
    expect(isSelfHostedDeployment(envWith(undefined))).toBe(false);
    expect(isSelfHostedDeployment(envWith("managed"))).toBe(false);
  });

  it("returns true for self_hosted", () => {
    expect(isSelfHostedDeployment(envWith("self_hosted"))).toBe(true);
  });

  it("propagates the validation error for invalid values", () => {
    expect(() => isSelfHostedDeployment(envWith("selfhosted"))).toThrow(
      /Invalid SDP_DEPLOYMENT_MODE/
    );
  });
});

describe("applyEphemeralOverrides", () => {
  it("rewrites the database name and redis db index when overrides are set", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgresql://sdp:s3cret@10.0.0.5:5432/sdp_api?sslmode=require",
      REDIS_URL: "redis://:authtoken@10.0.0.6:6379",
      EPHEMERAL_DB_NAME: "sdp_api_pr_123",
      EPHEMERAL_REDIS_DB: "4",
    };

    applyEphemeralOverrides(env);

    expect(env.DATABASE_URL).toBe(
      "postgresql://sdp:s3cret@10.0.0.5:5432/sdp_api_pr_123?sslmode=require"
    );
    expect(env.REDIS_URL).toBe("redis://:authtoken@10.0.0.6:6379/4");
  });

  it("is idempotent", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgresql://sdp@db:5432/sdp_api",
      EPHEMERAL_DB_NAME: "sdp_api_pr_7",
    };

    applyEphemeralOverrides(env);
    applyEphemeralOverrides(env);

    expect(env.DATABASE_URL).toBe("postgresql://sdp@db:5432/sdp_api_pr_7");
  });

  it("leaves URLs untouched without overrides", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgresql://sdp@db:5432/sdp_api",
      REDIS_URL: "redis://cache:6379",
    };

    applyEphemeralOverrides(env);

    expect(env.DATABASE_URL).toBe("postgresql://sdp@db:5432/sdp_api");
    expect(env.REDIS_URL).toBe("redis://cache:6379");
  });
});
