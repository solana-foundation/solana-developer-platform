import { DEFAULT_SDP_API_URL } from "@sdp/types";
import { afterEach, describe, expect, it } from "vitest";
import app from "@/index";
import { createPublicOpenApiDocument } from "@/openapi/spec";
import { buildLlmsBody } from "@/routes/llms";
import { env } from "@/test/helpers/env";

/**
 * PUBLICATION GATE (SOLA9-47 / APE-710). /llms.txt is a second, hand-written
 * discovery surface, so it must not drift from the gated public OpenAPI
 * document: a family held out of /openapi.json (Earn until PRO-2038) must be
 * held out of /llms.txt too, including any wording disclosing an anonymous
 * Earn tier. The optional-auth runtime tier itself is unchanged — it stays
 * covered by the earn route suites.
 */
describe("GET /llms.txt", () => {
  const originalMarketsEnabled = env.MARKETS_ENABLED;
  const originalEarnEnabled = env.EARN_ENABLED;

  afterEach(() => {
    env.MARKETS_ENABLED = originalMarketsEnabled;
    env.EARN_ENABLED = originalEarnEnabled;
  });

  it("returns the public API discovery document", async () => {
    const res = await app.request("/llms.txt", {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toContain("public");

    const body = await res.text();
    expect(body).toContain("/openapi.json");
    expect(body).toContain("/docs");
    expect(body).toContain("/v1/api-keys");
    expect(body).toContain("/v1/wallets");
    expect(body).not.toContain("/admin/allowlist");
    expect(body).not.toContain("/v1/onboarding");
    expect(body).not.toContain("/v1/organizations");
  });

  it("advertises no family that the default public OpenAPI document holds back", async () => {
    const res = await app.request("/llms.txt", {}, env);
    const body = await res.text();
    const publicPaths = Object.keys(createPublicOpenApiDocument().paths ?? {});

    // Every representative URL the "Public endpoint families" section
    // advertises must resolve against the public contract: the full advertised
    // path must be published exactly or be a prefix of a published path.
    // Checking the full path (not just the leading /v1/<family> segment)
    // catches broken discovery links — e.g. an Asset Profiles line pointing at
    // a nonexistent path under /v1/issuance would still pass a segment-only
    // check because other issuance paths exist. On the vulnerable baseline
    // this catches the hard-coded `- Earn: .../v1/earn` line too: no public
    // path is at or under /v1/earn while EARN_PUBLIC_SURFACE_PUBLISHED is
    // false.
    const familiesSection = body.split("## Public endpoint families")[1] ?? "";
    expect(familiesSection.trim().length).toBeGreaterThan(0);
    const advertisedPaths = Array.from(
      familiesSection.matchAll(/^- [^:\n]+: https:\/\/[^/\s]+(\/[^\s]+)$/gm),
      (match) => match[1]
    );
    expect(advertisedPaths.length).toBeGreaterThan(0);
    for (const advertisedPath of advertisedPaths) {
      expect(
        publicPaths.some(
          (path) => path === advertisedPath || path.startsWith(`${advertisedPath}/`)
        ),
        `/llms.txt advertises ${advertisedPath}, which the public OpenAPI document does not publish`
      ).toBe(true);
    }
    expect(publicPaths.some((path) => path === "/health")).toBe(true);

    // The unpublished Earn family and its anonymous-tier wording must not be
    // disclosed anywhere in the discovery body.
    expect(body).not.toContain("/v1/earn");
    expect(body).not.toMatch(/anonymous/i);
  });

  it("mirrors every family the default public OpenAPI document publishes", async () => {
    const res = await app.request("/llms.txt", {}, env);
    const body = await res.text();
    const publicTags = (createPublicOpenApiDocument().tags ?? []).map((tag) => tag.name);

    expect(publicTags.length).toBeGreaterThan(0);
    for (const tag of publicTags) {
      const label = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(body, `family line for public tag "${tag}"`).toMatch(
        new RegExp(`^\\s*-\\s*[^:\\n]*${label}`, "im")
      );
    }
  });

  it("stays gated when the Earn and Markets runtime feature flags are enabled", async () => {
    // The publication hold is a build-time contract, not a runtime flag:
    // enabling MARKETS_ENABLED/EARN_ENABLED must not leak Earn discovery.
    env.MARKETS_ENABLED = "true";
    env.EARN_ENABLED = "true";

    const res = await app.request("/llms.txt", {}, env);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain("/v1/earn");
    expect(body).not.toMatch(/anonymous/i);
  });

  it("keeps the optional-auth Earn runtime tier working while discovery stays gated", async () => {
    // Runtime compatibility: the keyless strategy catalogue is an intentional
    // tier (spec.test.ts optional-auth boundary). Gating discovery must not
    // change what the route accepts.
    env.MARKETS_ENABLED = "true";
    env.EARN_ENABLED = "true";

    const catalogue = await app.request("/v1/earn/strategies?environment=sandbox", {}, env);
    expect(catalogue.status).toBe(200);
    expect(catalogue.headers.get("cache-control")).toContain("public");

    const discovery = await app.request("/llms.txt", {}, env);
    expect(await discovery.text()).not.toContain("/v1/earn");
  });

  it("discloses Earn again once the public document publishes it", () => {
    // Deployment compatibility for the PRO-1872 sign-off flip: because the
    // body is derived from the public document, flipping
    // EARN_PUBLIC_SURFACE_PUBLISHED restores the Earn line and the
    // anonymous-tier wording without a second edit.
    const unpublished = buildLlmsBody(createPublicOpenApiDocument());
    expect(unpublished).not.toContain("Earn");

    const published = buildLlmsBody(createPublicOpenApiDocument({ publishEarn: true }));
    expect(published).toContain(`- Earn: ${DEFAULT_SDP_API_URL}/v1/earn`);
    expect(published).toMatch(/may be anonymous/);
  });
});
