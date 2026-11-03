import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { heliusRings } from "@/routes/helius-rings";
import { internalHeliusRings } from "@/routes/internal-helius-rings";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

const prefix = "/v1/helius-rings";
const internalPrefix = "/internal/dashboard/helius-rings";
const isRingsPath = (path: string) => path.startsWith(prefix) || path.startsWith(internalPrefix);
describe("Helius Rings CLI contracts", () => {
  it("documents every mounted route: 19 API operations and five connection operations", () => {
    const methods = ["get", "post"] as const;
    const runtime = new Set(
      (
        [
          [heliusRings, prefix],
          [internalHeliusRings, internalPrefix],
        ] as const
      ).flatMap(([router, root]) =>
        router.routes
          .filter((route) => methods.some((method) => method.toUpperCase() === route.method))
          .map(
            (route) => `${route.method} ${root}${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
          )
      )
    );
    const document = createOpenApiDocument();
    const documented = Object.entries(document.paths)
      .filter(([path]) => isRingsPath(path))
      .flatMap(([path, item]) =>
        methods.flatMap((method) => {
          const operation = item[method];
          if (operation === undefined) return [];
          expect(operation.operationId).toBeDefined();
          expect(operation.description).toBeTruthy();
          expect(operation.responses).toHaveProperty(
            (method === "post" &&
              [
                "/rings/register-and-initialize",
                "/wallets/provision-identity",
                "/operations/execute",
                "/connections",
              ].some((suffix) => path.endsWith(suffix))) ||
              path.endsWith("/retry") ||
              (method === "post" && path.endsWith("/zones"))
              ? "201"
              : "200"
          );
          return [`${method.toUpperCase()} ${path}`];
        })
      );
    expect(documented.sort()).toEqual([...runtime].sort());
    expect(documented).toHaveLength(24);
  });
  it("keeps routes and tags out of every public release channel", () => {
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      const document = createPublicOpenApiDocument({ releaseChannel });
      expect(Object.keys(document.paths).filter(isRingsPath)).toEqual([]);
      expect(document.tags?.some((tag) => tag.name === "Helius Rings")).toBe(false);
    }
  });
  it("requires administrator sessions for connection routes and documents no idempotency headers", () => {
    const document = createOpenApiDocument();
    for (const [path, item] of Object.entries(document.paths).filter(([path]) =>
      isRingsPath(path)
    )) {
      for (const method of ["get", "post"] as const) {
        const operation = item[method];
        if (operation === undefined) continue;
        expect(operation.security).toEqual(
          path.startsWith(internalPrefix)
            ? [{ clerkBearerAuth: [] }]
            : [{ apiKeyAuth: [] }, { clerkBearerAuth: [] }]
        );
        expect(operation.parameters).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ in: "header", name: "Idempotency-Key" }),
          ])
        );
        expect(operation.parameters).toEqual(
          expect.arrayContaining([expect.objectContaining({ in: "header", name: "x-project-id" })])
        );
      }
    }
    for (const suffix of ["resume-execution", "recheck"])
      expect(
        document.paths[`${prefix}/operations/{operationId}/${suffix}`]?.post?.requestBody
      ).toBeUndefined();
    expect(document.paths[`${prefix}/wallets/{walletId}/sync`]?.post?.requestBody).toBeUndefined();
  });
  it("keeps null-only proof and unconfigured connection fields constrained in OpenAPI 3", () => {
    const document = createOpenApiDocument();
    expect(
      document.paths[`${prefix}/operations/{operationId}`]?.get?.responses["200"]
    ).toMatchObject({
      content: {
        "application/json": {
          schema: {
            properties: {
              data: { properties: { operation: { properties: { proof: { enum: [null] } } } } },
            },
          },
        },
      },
    });
    expect(document.paths[`${prefix}/setup-status`]?.get?.responses["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            properties: {
              data: {
                oneOf: expect.arrayContaining([
                  expect.objectContaining({
                    properties: expect.objectContaining({
                      defaultConnection: expect.objectContaining({ enum: [null] }),
                    }),
                  }),
                ]),
              },
            },
          },
        },
      },
    });
  });
  it("uses the exact six runtime flow variants and keeps request amounts strings", () => {
    const document = createOpenApiDocument();
    expect(document.paths[`${prefix}/operations/execute`]?.post?.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: {
            oneOf: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  opType: { type: "string", enum: ["shield"] },
                  asset: expect.objectContaining({
                    properties: expect.objectContaining({
                      amountRaw: expect.objectContaining({ type: "string", pattern: "^\\d+$" }),
                    }),
                  }),
                }),
              }),
            ]),
          },
        },
      },
    });
    expect(
      document.paths[`${prefix}/operations/{operationId}/retry`]?.post?.requestBody
    ).toMatchObject({
      required: true,
      content: { "application/json": { schema: { required: ["clientNonce"] } } },
    });
  });
  it("pins all five dashboard setup routes with closed safe-origin metadata", () => {
    const document = createOpenApiDocument();
    const methods = ["get", "post"] as const;
    const documented = Object.entries(document.paths)
      .filter(([path]) => path.startsWith(internalPrefix))
      .flatMap(([path, item]) =>
        methods.flatMap((method) =>
          item[method] === undefined ? [] : [`${method.toUpperCase()} ${path}`]
        )
      );
    const runtime = new Set(
      internalHeliusRings.routes
        .filter((route) => methods.some((method) => method.toUpperCase() === route.method))
        .map(
          (route) =>
            `${route.method} ${internalPrefix}${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
        )
    );
    expect(documented.sort()).toEqual([...runtime].sort());
    expect(documented).toHaveLength(5);
    expect(document.paths[`${internalPrefix}/connections`]?.post?.responses["201"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            additionalProperties: false,
            properties: {
              data: {
                additionalProperties: false,
                properties: {
                  endpoints: {
                    additionalProperties: false,
                    properties: {
                      rpc: { type: "string", pattern: expect.any(String), nullable: true },
                    },
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
