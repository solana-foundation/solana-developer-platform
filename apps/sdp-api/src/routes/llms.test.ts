import { describe, expect, it } from "vitest";
import app from "@/index";
import { env } from "@/test/helpers/env";

describe("GET /llms.txt", () => {
  it("returns the public API discovery document", async () => {
    const res = await app.request("/llms.txt", {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("/openapi.json");
    expect(body).toContain("/docs");
    expect(body).toContain("/v1/api-keys");
    expect(body).toContain("/v1/wallets");
    expect(body).not.toContain("/admin/allowlist");
    expect(body).not.toContain("/v1/onboarding");
    expect(body).not.toContain("/v1/organizations");
  });

  // PUBLICATION HOLD (PRO-2038). The discovery document must mirror the
  // supported public surface, and the public OpenAPI document it points at
  // carries no Earn operation until the PRO-1872 security sign-off flips the
  // hold (see openapi/spec.ts). Advertising `/v1/earn` here would direct AI
  // agents at a family the contract omits.
  it("holds the Earn family out of the public discovery document", async () => {
    const res = await app.request("/llms.txt", {}, env);
    const body = await res.text();

    expect(body).not.toMatch(/\/v1\/earn/i);
    expect(body).not.toMatch(/\bearn\b/i);
  });
});
