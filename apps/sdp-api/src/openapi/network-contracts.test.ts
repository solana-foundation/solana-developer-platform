import { NETWORK_HEALTH_STATES, NETWORK_METRIC_IDS } from "@sdp/types/network-metrics";
import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { internalNetwork } from "@/routes/internal-network";
import routeActions from "./route-actions.generated.json";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

const prefix = "/internal/dashboard/network";
describe("Dashboard network-data CLI contract", () => {
  it("documents the mounted snapshot route only internally on every release channel", () => {
    const runtime = new Set(
      internalNetwork.routes
        .filter((route) => route.method === "GET")
        .map((route) => `${route.method} ${prefix}${route.path === "/" ? "" : route.path}`)
    );
    const documented = Object.entries(createOpenApiDocument().paths)
      .filter(([path]) => path === prefix || path.startsWith(`${prefix}/`))
      .flatMap(([path, item]) => (item.get === undefined ? [] : [`GET ${path}`]));
    expect(documented).toEqual([...runtime]);
    expect(documented).toHaveLength(1);
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      const publicDocument = createPublicOpenApiDocument({ releaseChannel });
      expect(Object.keys(publicDocument.paths).filter((path) => path.startsWith(prefix))).toEqual(
        []
      );
      expect(publicDocument.tags?.some((tag) => tag.name === "Dashboard Network Data")).toBe(false);
    }
  });
  it("requires a human session without inventing a tenant action or project header", () => {
    const operation = createOpenApiDocument().paths[prefix]?.get;
    expect(operation).toMatchObject({
      operationId: "getDashboardNetworkSnapshot",
      security: [{ clerkBearerAuth: [] }],
      description: expect.stringContaining("No tenant action"),
    });
    expect(operation?.parameters ?? []).toEqual([]);
    expect(operation?.requestBody).toBeUndefined();
    expect(routeActions).not.toHaveProperty(`GET ${prefix}`);
    expect(operation?.responses).toHaveProperty("503");
    expect(operation?.responses).toHaveProperty("403");
  });
  it("preserves the shared snapshot's dates, nullable health, and exhaustive metric record", () => {
    expect(createOpenApiDocument().paths[prefix]?.get?.responses["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            required: ["data", "meta"],
            properties: {
              data: {
                required: ["asOf", "health", "metrics"],
                properties: {
                  asOf: { type: "string", format: "date" },
                  health: {
                    type: "object",
                    nullable: true,
                    required: ["state", "checkedAt"],
                    properties: {
                      state: { type: "string", enum: [...NETWORK_HEALTH_STATES] },
                      checkedAt: { type: "string", format: "date-time" },
                    },
                  },
                  metrics: {
                    type: "object",
                    required: [...NETWORK_METRIC_IDS],
                    additionalProperties: false,
                    properties: Object.fromEntries(
                      NETWORK_METRIC_IDS.map((id) => [
                        id,
                        {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["date", "value"],
                            properties: {
                              date: { type: "string", format: "date" },
                              value: { type: "number" },
                            },
                          },
                        },
                      ])
                    ),
                  },
                },
              },
            },
          },
        },
      },
    });
  });
});
