import { SDP_RELEASE_CHANNEL_NAMES, SDP_RELEASE_CHANNELS } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { compliance } from "@/routes/compliance";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

describe("Compliance CLI contract", () => {
  it("covers the entire mounted family and follows its release-channel publication", () => {
    const path = "/v1/compliance/address-screenings";
    const runtime = new Set(
      compliance.routes
        .filter((route) => route.method === "POST")
        .map((route) => `POST /v1/compliance${route.path}`)
    );
    const document = createOpenApiDocument();
    expect([...runtime]).toEqual([`POST ${path}`]);
    expect(
      Object.keys(document.paths).filter((name) => name.startsWith("/v1/compliance/"))
    ).toEqual([path]);
    expect(document.paths[path]?.post?.operationId).toBe("screenComplianceAddress");
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES)
      expect(createPublicOpenApiDocument({ releaseChannel }).paths[path]?.post !== undefined).toBe(
        SDP_RELEASE_CHANNELS[releaseChannel].includes("compliance")
      );
  });
  it("documents a required body, optional replay key, project header, and execute permission", () => {
    const operation = createOpenApiDocument().paths["/v1/compliance/address-screenings"]?.post;
    expect(operation?.requestBody).toMatchObject({ required: true });
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: "header", name: "Idempotency-Key", required: false }),
        expect.objectContaining({ in: "header", name: "x-project-id" }),
      ])
    );
    expect(operation?.responses["403"]).toMatchObject({
      description: expect.stringContaining("compliance.execute"),
    });
    expect(operation?.responses).toHaveProperty("200");
  });
});
