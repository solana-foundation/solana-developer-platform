import { describe, expect, it } from "vitest";
import { earnRoutes } from "@/routes/earn";
import { EARN_GROUPS } from "./paths/earn-groups";
import { DOCS_GROUP } from "./paths/helpers";
import { createOpenApiDocument, createPublicOpenApiDocument } from "./spec";

/** The reference groups the public document carries. Every other group is internal. */
const PUBLISHED_GROUPS: readonly string[] = [
  EARN_GROUPS.discovery,
  EARN_GROUPS.embeddedYield,
  EARN_GROUPS.treasury,
];
/** An operator's report that sits with Treasury in the internal reference and is never published. */
const INTERNAL_TREASURY_PATHS = new Set(["/v1/earn/vault-share-reconciliation"]);

describe("Earn API contract coverage", () => {
  it("documents every mounted Earn operation internally, with an operation id and response", () => {
    const document = createOpenApiDocument();
    const runtime = new Set(
      earnRoutes.routes
        .filter((route) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(route.method))
        .map(
          (route) => `${route.method} /v1/earn${route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`
        )
    );
    const documented = new Set(
      Object.entries(document.paths)
        .filter(([path]) => path.startsWith("/v1/earn/"))
        .flatMap(([path, item]) =>
          Object.entries(item)
            .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
            .map(([method, operation]) => {
              expect(operation).toHaveProperty("operationId");
              expect(operation).toHaveProperty("responses.200");
              return `${method.toUpperCase()} ${path}`;
            })
        )
    );
    expect([...documented].sort()).toEqual([...runtime].sort());
  });

  it("keeps every Earn operation authenticated and internal groups out of the public document", () => {
    const internal = createOpenApiDocument();
    const published = createPublicOpenApiDocument({ releaseChannel: "experimental" });
    for (const [path, item] of Object.entries(internal.paths)) {
      if (!path.startsWith("/v1/earn/")) continue;
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = item[method];
        if (!operation) continue;
        expect(operation.security).toBeDefined();
        expect(operation.security).not.toContainEqual({});
        const group = operation[DOCS_GROUP];
        const isPublished =
          typeof group === "string" &&
          PUBLISHED_GROUPS.includes(group) &&
          !INTERNAL_TREASURY_PATHS.has(path);
        expect(published.paths[path]?.[method] !== undefined, `${method} ${path}`).toBe(
          isPublished
        );
      }
    }
  });

  it("groups every Earn operation for the reference without changing its publication scope", () => {
    const groups = new Set<string>();
    const internal = createOpenApiDocument();
    for (const [path, item] of Object.entries(internal.paths)) {
      if (!path.startsWith("/v1/earn/")) continue;
      for (const method of ["get", "post", "put"] as const) {
        const operation = item[method];
        if (!operation) continue;
        const group = operation[DOCS_GROUP];
        expect(Object.values(EARN_GROUPS)).toContain(group);
        if (typeof group === "string") groups.add(group);
      }
    }
    expect([...groups].sort()).toEqual(Object.values(EARN_GROUPS).sort());

    const partner = createPublicOpenApiDocument({
      releaseChannel: "experimental",
    });
    for (const [path, item] of Object.entries(partner.paths)) {
      if (!path.startsWith("/v1/earn/")) continue;
      for (const method of ["get", "post"] as const) {
        const operation = item[method];
        if (!operation) continue;
        expect(PUBLISHED_GROUPS).toContain(operation[DOCS_GROUP]);
      }
    }
  });
});
