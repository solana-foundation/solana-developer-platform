import { describe, expect, it } from "vitest";
import { privateChannels } from "@/routes/private-channels";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

describe("Private Channels CLI contracts", () => {
  it("documents all 35 mounted operations and keeps the entire family internal", () => {
    const methods = ["get", "post", "patch", "delete"] as const;
    const runtime = new Set(
      privateChannels.routes
        .filter((route) => methods.some((method) => method.toUpperCase() === route.method))
        .map((route) =>
          `${route.method} /v1/private-channels${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`.replace(
            /\/$/,
            ""
          )
        )
    );
    const document = createOpenApiDocument();
    const documented = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/v1/private-channels/"))
      .flatMap(([path, item]) =>
        methods.flatMap((method) => {
          const operation = item[method];
          if (operation === undefined) return [];
          expect(operation.operationId).toBeDefined();
          expect(operation.security?.length).toBeGreaterThan(0);
          return [`${method.toUpperCase()} ${path}`];
        })
      );
    expect(documented.sort()).toEqual([...runtime].sort());
    expect(documented).toHaveLength(35);
    for (const releaseChannel of ["stable", "experimental"] as const)
      expect(
        Object.keys(createPublicOpenApiDocument({ releaseChannel }).paths).filter((path) =>
          path.startsWith("/v1/private-channels")
        )
      ).toEqual([]);
  });
  it("declares configuration session-only, money keys required, and verification body explicit", () => {
    const document = createOpenApiDocument();
    for (const [path, method] of [
      ["/v1/private-channels/instance-connection/connect", "post"],
      ["/v1/private-channels/instance-connection", "patch"],
      ["/v1/private-channels/instance-connection", "delete"],
      ["/v1/private-channels/instance-connection/disconnect", "post"],
      ["/v1/private-channels/principals", "post"],
      ["/v1/private-channels/principals/{principalId}", "delete"],
      ["/v1/private-channels/channels/{channelId}/principal-memberships", "post"],
      ["/v1/private-channels/channels/{channelId}/principal-memberships/{principalId}", "delete"],
    ] as const)
      expect(document.paths[path]?.[method]?.security).toEqual([{ clerkBearerAuth: [] }]);
    for (const path of [
      "/v1/private-channels/deposits",
      "/v1/private-channels/withdrawals",
      "/v1/private-channels/channels/{channelId}/transfers",
    ])
      expect(document.paths[path]?.post?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ in: "header", name: "Idempotency-Key", required: true }),
        ])
      );
    expect(
      document.paths["/v1/private-channels/wallets/{walletId}/verify"]?.post?.requestBody
    ).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", properties: { principalId: { type: "string" } } },
        },
      },
    });
  });
});
