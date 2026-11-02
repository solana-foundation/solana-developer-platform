import { SDP_RAMP_PROVIDER_MATURITY, SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { routeActionKey } from "@/routes/route-actions";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

const balancePath = "/v1/payments/wallets/{walletId}/balances";
const onboardingPath = "/v1/onboarding/status";
describe("Wallet balance and onboarding CLI contracts", () => {
  it("matches both documented reads to registered handlers", () => {
    const app = createApp({ rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY });
    const runtime = new Set(app.routes.map((route) => routeActionKey(route.method, route.path)));
    for (const path of [balancePath, onboardingPath]) {
      expect(runtime.has(routeActionKey("GET", path))).toBe(true);
      expect(createOpenApiDocument().paths[path]?.get?.requestBody).toBeUndefined();
    }
  });
  it("documents exact provider wallet IDs and canonical minimum slot bounds", () => {
    const operation = createOpenApiDocument().paths[balancePath]?.get;
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          in: "path",
          name: "walletId",
          required: true,
          schema: expect.objectContaining({
            description: expect.stringContaining("Provider wallet ID"),
          }),
        }),
        expect.objectContaining({
          in: "query",
          name: "minimumSlot",
          required: false,
          schema: { type: "string", pattern: "^(0|[1-9]\\d*)$" },
        }),
        expect.objectContaining({ in: "header", name: "x-project-id" }),
      ])
    );
    expect(operation?.responses["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            properties: {
              data: {
                properties: {
                  balanceReadContext: {
                    properties: {
                      minimumSlot: {
                        type: "integer",
                        minimum: 0,
                        maximum: Number.MAX_SAFE_INTEGER,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(operation?.responses).toHaveProperty("503");
  });
  it("requires Clerk onboarding sessions without a tenant action or selected project", () => {
    const operation = createOpenApiDocument().paths[onboardingPath]?.get;
    expect(operation?.security).toEqual([{ clerkBearerAuth: [] }]);
    expect(operation?.parameters ?? []).toEqual([]);
    expect(operation?.description).toContain("has not been linked to SDP");
    expect(operation?.responses["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            properties: {
              data: {
                required: ["linked", "organization", "setup"],
                properties: {
                  linked: { type: "boolean" },
                  organization: { nullable: true },
                  setup: { nullable: true },
                },
              },
            },
          },
        },
      },
    });
  });
  it("keeps onboarding internal and balances in the supported public payments surface", () => {
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      const document = createPublicOpenApiDocument({ releaseChannel });
      expect(document.paths[onboardingPath]).toBeUndefined();
      expect(document.paths[balancePath]?.get?.operationId).toBe("getPaymentWalletBalances");
    }
  });
});
