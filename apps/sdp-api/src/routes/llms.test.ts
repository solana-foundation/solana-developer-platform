import { describe, expect, it } from "vitest";
import app from "@/index";
import { createPublicOpenApiDocument, EARN_PUBLIC_SURFACE_PUBLISHED } from "@/openapi/spec";
import { PUBLIC_FAMILY_ENTRY_PATHS } from "@/routes/llms";
import { env } from "@/test/helpers/env";

const listedFamilies = (body: string) =>
  body
    .split("## Public endpoint families\n")[1]
    ?.split("\n\n")[0]
    ?.split("\n")
    .map((line) => line.replace(/^- /, "").split(":")[0]);

describe("GET /llms.txt", () => {
  it("returns the public API discovery document", async () => {
    const res = await app.request("/llms.txt", {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("/openapi.json");
    expect(body).toContain("/docs/reference/docs-for-ai");
    expect(body).toContain("/v1/api-keys");
    expect(body).toContain("/v1/wallets");
    expect(body).not.toContain("/admin/allowlist");
    expect(body).not.toContain("/v1/onboarding");
    expect(body).not.toContain("/v1/organizations");
  });

  it("lists exactly the families the public OpenAPI document publishes", async () => {
    const body = await (await app.request("/llms.txt", {}, env)).text();

    expect(listedFamilies(body)).toEqual(
      createPublicOpenApiDocument().tags?.map((tag) => tag.name)
    );
    // Earn stays off every public surface until PRO-2038 flips the constant.
    expect(body.includes("/v1/earn")).toBe(EARN_PUBLIC_SURFACE_PUBLISHED);
    expect(body.includes("Earn")).toBe(EARN_PUBLIC_SURFACE_PUBLISHED);
  });

  it("has an entry path for every family the public document can publish", () => {
    const publishable = createPublicOpenApiDocument({ publishEarn: true }).tags ?? [];

    for (const { name } of publishable) {
      expect(PUBLIC_FAMILY_ENTRY_PATHS[name], name).toBeDefined();
    }
  });
});
