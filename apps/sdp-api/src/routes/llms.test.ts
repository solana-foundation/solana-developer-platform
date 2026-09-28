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
    // Earn is held out of every public surface until launch (PRO-2038): the
    // public OpenAPI document and the AI files carry no Earn operation, so the
    // discovery document must not advertise the family either.
    expect(body).not.toContain("/v1/earn");
    expect(body).not.toContain("Earn");
  });
});
