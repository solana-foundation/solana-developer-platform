import { describe, expect, it } from "vitest";
import app from "@/index";
import { env } from "@/test/helpers/env";

async function llmsBody(releaseChannel: string): Promise<string> {
  const res = await app.request("/llms.txt", {}, { ...env, SDP_RELEASE_CHANNEL: releaseChannel });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  return res.text();
}

describe("GET /llms.txt", () => {
  it("returns the public API discovery document", async () => {
    const body = await llmsBody("experimental");

    expect(body).toContain("/openapi.json");
    expect(body).toContain("/docs");
    expect(body).toContain("- API Keys: https://");
    expect(body).toContain("/v1/api-keys");
    expect(body).toContain("/v1/wallets");
    expect(body).toContain("/v1/issuance");
    expect(body).not.toContain("/admin/allowlist");
    expect(body).not.toContain("/v1/onboarding");
    expect(body).not.toContain("/v1/organizations");
  });

  it("lists only the families the deployment's release channel publishes", async () => {
    const body = await llmsBody("stable");

    expect(body).toContain("/v1/payments");
    expect(body).toContain("/v1/compliance");
    expect(body).not.toContain("/v1/issuance");
    expect(body).not.toMatch(/earn/i);
  });

  it("leaves Earn out on every channel while its publication hold is on", async () => {
    for (const releaseChannel of ["experimental", "beta", "stable"]) {
      expect(await llmsBody(releaseChannel)).not.toMatch(/earn/i);
    }
  });
});
