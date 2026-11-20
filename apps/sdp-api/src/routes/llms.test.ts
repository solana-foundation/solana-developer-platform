import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { app } from "@/index";
import { env } from "@/test/helpers/env";

async function llmsBody(releaseChannel: string): Promise<string> {
  const res = await app.request("/llms.txt", {}, { ...env, SDP_RELEASE_CHANNEL: releaseChannel });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  return res.text();
}

function familySection(body: string): string {
  const sections = body.split("## Public endpoint families\n");
  expect(sections).toHaveLength(2);
  const section = sections[1];
  if (section === undefined) throw new Error("Missing public endpoint families section");
  return section.split("\n\n")[0];
}

describe("GET /llms.txt", () => {
  it("returns the public API discovery document", async () => {
    const body = await llmsBody("experimental");

    expect(body).toContain("/openapi.json");
    expect(body).toContain("https://platform.solana.com/docs/reference/api");
    // Keys are managed in the dashboard by a signed-in person (HOO-2099).
    expect(body).not.toContain("/v1/api-keys");
    expect(body).toContain("/v1/wallets");
    expect(body).toContain("/v1/issuance");
    expect(body).toContain("/v1/compliance");
    expect(body).toContain("/v1/earn");
    expect(body).toContain("/v1/operations");
    expect(body).not.toContain("/admin/allowlist");
    expect(body).not.toContain("/v1/onboarding");
    expect(body).not.toContain("/v1/organizations");
  });

  it.each(["beta", "stable"])("lists only the families %s publishes", async (channel) => {
    const body = await llmsBody(channel);

    expect(body).toContain("/v1/payments");
    expect(body).not.toContain("/v1/compliance");
    expect(body).not.toContain("/v1/issuance");
  });

  it.each(["experimental", "beta", "stable"])(
    "%s applies the same module release channel to Earn and operations",
    async (releaseChannel) => {
      const body = await llmsBody(releaseChannel);
      const published = releaseChannel !== "stable";
      expect(body.includes("/v1/earn")).toBe(published);
      expect(body.includes("/v1/operations")).toBe(published);
    }
  );

  it("matches the committed docs family list on experimental", async () => {
    const docs = await readFile(
      new URL("../../../sdp-docs/public/llms.txt", import.meta.url),
      "utf8"
    );
    expect(familySection(docs)).toBe(familySection(await llmsBody("experimental")));
  });
});
