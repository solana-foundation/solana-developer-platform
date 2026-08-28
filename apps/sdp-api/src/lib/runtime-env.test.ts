import { describe, expect, it } from "vitest";
import { applyEphemeralOverrides } from "./runtime-env";

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
