import { describe, expect, it } from "vitest";
import { assetProfiles } from "@/routes/asset-profiles";
import { issuance } from "@/routes/issuance";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

describe("Issuance and asset-profile CLI contracts", () => {
  it("documents all 44 mounted operations", () => {
    const methods = ["get", "post", "patch", "delete"] as const;
    const runtime = new Set(
      (
        [
          [issuance, "/v1/issuance"],
          [assetProfiles, "/v1/issuance/asset-profiles"],
        ] as const
      ).flatMap(([router, prefix]) => {
        return router.routes
          .filter((route) => methods.some((method) => method.toUpperCase() === route.method))
          .map((route) =>
            `${route.method} ${prefix}${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`.replace(
              /\/$/,
              ""
            )
          );
      })
    );
    const document = createOpenApiDocument();
    const documented = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/v1/issuance/"))
      .flatMap(([path, item]) =>
        methods.flatMap((method) => {
          const operation = item[method];
          if (operation === undefined) return [];
          expect(operation.operationId).toBeDefined();
          return [`${method.toUpperCase()} ${path}`];
        })
      );
    expect(documented.sort()).toEqual([...runtime].sort());
    expect(documented).toHaveLength(44);
  });

  it("declares only metadata anonymous and documents the existing deploy bodies", () => {
    for (const document of [
      createOpenApiDocument(),
      createPublicOpenApiDocument({ releaseChannel: "experimental" }),
    ]) {
      const metadata = document.paths["/v1/issuance/tokens/{tokenId}/metadata.json"]?.get;
      expect(metadata?.security).toEqual([]);
      expect(metadata?.parameters).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ in: "header" })])
      );
      for (const path of [
        "/v1/issuance/tokens/{tokenId}/deploy/build-unsigned-transaction",
        "/v1/issuance/tokens/{tokenId}/deploy/metadata/build-unsigned-transaction",
      ]) {
        const operation = document.paths[path]?.post;
        expect(operation?.requestBody).toMatchObject({
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { signingWalletId: { type: "string" }, feePayment: { type: "string" } },
              },
            },
          },
        });
      }
      for (const [path, item] of Object.entries(document.paths)) {
        if (!path.startsWith("/v1/issuance/")) continue;
        for (const method of ["get", "post", "patch", "delete"] as const) {
          const operation = item[method];
          if (operation === undefined || operation.operationId === "getTokenMetadataJson") continue;
          expect(operation.security).toEqual([{ apiKeyAuth: [] }]);
        }
      }
    }
  });

  it("documents the existing 200-row holder page and repeated issuance transaction types", () => {
    const document = createOpenApiDocument();
    expect(
      document.paths["/v1/issuance/tokens/{tokenId}/holder-enrollments"]?.get?.parameters
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          in: "query",
          name: "pageSize",
          schema: expect.objectContaining({ maximum: 200 }),
        }),
      ])
    );
    expect(document.paths["/v1/issuance/transactions"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          in: "query",
          name: "type",
          schema: expect.objectContaining({ type: "array" }),
        }),
      ])
    );
  });
});
