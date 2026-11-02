import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { internalWallets } from "@/routes/custody/internal";
import { internalCustody } from "@/routes/internal-custody";
import { internalFireblocks } from "@/routes/internal-fireblocks";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

const roots = [
  "/internal/dashboard/custody",
  "/internal/dashboard/wallets",
  "/internal/dashboard/fireblocks",
];
const isCustodyPath = (path: string) => roots.some((root) => path.startsWith(`${root}/`));
describe("Dashboard custody CLI contracts", () => {
  it("documents all 16 setup routes and both related dashboard helpers, always internally", () => {
    const methods = ["get", "post"] as const;
    const runtime = new Set(
      (
        [
          [internalCustody, roots[0]],
          [internalWallets, roots[1]],
          [internalFireblocks, roots[2]],
        ] as const
      ).flatMap(([router, root]) =>
        router.routes
          .filter((route) => methods.some((method) => method.toUpperCase() === route.method))
          .map(
            (route) => `${route.method} ${root}${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
          )
      )
    );
    const documented = Object.entries(createOpenApiDocument().paths)
      .filter(([path]) => isCustodyPath(path))
      .flatMap(([path, item]) =>
        methods.flatMap((method) =>
          item[method] === undefined ? [] : [`${method.toUpperCase()} ${path}`]
        )
      );
    expect(documented.sort()).toEqual([...runtime].sort());
    expect(documented).toHaveLength(18);
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES)
      expect(
        Object.keys(createPublicOpenApiDocument({ releaseChannel }).paths).filter(isCustodyPath)
      ).toEqual([]);
  });
  it("requires project-scoped member sessions and keys only for the four keyed writes", () => {
    const document = createOpenApiDocument();
    let keys = 0;
    for (const [, item] of Object.entries(document.paths).filter(([path]) => isCustodyPath(path)))
      for (const method of ["get", "post"] as const) {
        const operation = item[method];
        if (operation === undefined) continue;
        expect(operation.security).toEqual([{ clerkBearerAuth: [] }]);
        expect(operation.parameters).toEqual(
          expect.arrayContaining([expect.objectContaining({ in: "header", name: "x-project-id" })])
        );
        for (const parameter of operation.parameters ?? [])
          if ("name" in parameter && parameter.name === "Idempotency-Key") {
            keys += 1;
            expect(parameter.required).toBe(true);
          }
      }
    expect(keys).toBe(4);
  });
  it("documents explicit empty CSR/faucet bodies and safe credential metadata", () => {
    const document = createOpenApiDocument();
    for (const path of [
      "/internal/dashboard/custody/fireblocks/csr",
      "/internal/dashboard/wallets/{walletId}/faucet",
    ])
      expect(document.paths[path]?.post?.requestBody).toMatchObject({
        required: true,
        content: {
          "application/json": { schema: { type: "object", additionalProperties: false } },
        },
      });
    expect(
      document.paths["/internal/dashboard/custody/provider-credentials"]?.post?.responses["201"]
    ).toMatchObject({
      content: {
        "application/json": {
          schema: {
            properties: {
              data: {
                additionalProperties: false,
                properties: {
                  providerCredential: {
                    additionalProperties: false,
                    properties: { displayMetadata: { additionalProperties: false } },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(
      document.paths["/internal/dashboard/fireblocks/destination-eligibility"]?.get?.description
    ).toContain("counterparties.read");
  });
});
