import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { webhooks } from "@/routes/webhooks";
import { MAX_WEBHOOK_BODY_BYTES } from "@/routes/webhooks/schemas";
import { RAMP_PROVIDER_WEBHOOK_PROCESSOR } from "@/services/ramps/webhooks/registry";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

const prefix = "/webhooks";
describe("Webhook ingress CLI contracts", () => {
  it("documents all three mounted ingress routes only in the internal document", () => {
    const runtime = new Set(
      webhooks.routes
        .filter((route) => route.method === "POST")
        .map((route) => `POST ${prefix}${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`)
    );
    const documented = Object.entries(createOpenApiDocument().paths)
      .filter(([path]) => path.startsWith(`${prefix}/`))
      .flatMap(([path, item]) => (item.post === undefined ? [] : [`POST ${path}`]));
    expect(documented.sort()).toEqual([...runtime].sort());
    expect(documented).toHaveLength(3);
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      const document = createPublicOpenApiDocument({ releaseChannel });
      expect(Object.keys(document.paths).filter((path) => path.startsWith(`${prefix}/`))).toEqual(
        []
      );
      expect(document.tags?.some((tag) => tag.name === "Webhook Ingress")).toBe(false);
    }
  });
  it("pins signed raw payloads, limits and signature headers without tenant or retry headers", () => {
    const document = createOpenApiDocument();
    for (const [path, item] of Object.entries(document.paths).filter(([path]) =>
      path.startsWith(`${prefix}/`)
    )) {
      const operation = item.post;
      expect(operation?.requestBody).toMatchObject({
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "string",
              format: "binary",
              minLength: 1,
              maxLength: MAX_WEBHOOK_BODY_BYTES,
            },
          },
        },
      });
      const headers = operation?.parameters?.flatMap((parameter) =>
        "in" in parameter && parameter.in === "header" ? [parameter.name] : []
      );
      const expected =
        path === `${prefix}/clerk`
          ? ["svix-id", "svix-timestamp", "svix-signature"]
          : Object.values(RAMP_PROVIDER_WEBHOOK_PROCESSOR).map(
              (processor) => processor.signature.header
            );
      expect(headers?.sort()).toEqual([...expected].sort());
      expect(operation?.responses).toHaveProperty("413");
      expect(operation?.responses).toHaveProperty("429");
      expect(operation?.responses).toHaveProperty("401");
    }
    expect(document.paths[`${prefix}/clerk`]?.post?.security).toEqual([
      { "svix-id": [], "svix-timestamp": [], "svix-signature": [] },
    ]);
    for (const environment of ["sandbox", "production"]) {
      const operation = document.paths[`${prefix}/payments/ramps/${environment}/{provider}`]?.post;
      expect(operation?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            in: "path",
            name: "provider",
            schema: { type: "string", enum: [...RAMP_PROVIDERS] },
          }),
        ])
      );
      expect(operation?.security).toEqual(
        Object.keys(RAMP_PROVIDER_WEBHOOK_PROCESSOR).map((provider) => ({
          [`${provider}WebhookSignature`]: [],
        }))
      );
    }
  });
  it("documents receipt separately from asynchronous settlement and pins acknowledgement shape", () => {
    const document = createOpenApiDocument();
    for (const environment of ["sandbox", "production"]) {
      const operation = document.paths[`${prefix}/payments/ramps/${environment}/{provider}`]?.post;
      expect(operation?.description).toContain("Receipt never proves transfer completion");
      expect(operation?.responses["200"]).toMatchObject({
        content: {
          "application/json": {
            schema: {
              properties: {
                data: {
                  type: "object",
                  required: ["received", "provider", "environment"],
                  additionalProperties: false,
                  properties: {
                    received: { enum: [true] },
                    provider: { enum: [...RAMP_PROVIDERS] },
                    environment: { enum: [environment] },
                  },
                },
              },
            },
          },
        },
      });
    }
  });
});
