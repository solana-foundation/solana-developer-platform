import { readFileSync } from "node:fs";
import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "@/app";
import { registeredRouteAuthorizations, routeActionKey } from "@/routes/route-actions";
import { createOpenApiDocument } from "./spec";

const contract = z
  .object({
    operations: z.array(
      z.object({ operationId: z.string(), method: z.string(), path: z.string() })
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL("../../../sdp-cli/src/contract.generated.json", import.meta.url), "utf8")
    )
  );

describe("CLI endpoint coverage", () => {
  it("maps every generated CLI operation to the current internal document and registered runtime", () => {
    const routes = registeredRouteAuthorizations(
      createApp({ rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY })
    );
    const registered = new Set(routes.map((route) => routeActionKey(route.method, route.path)));
    const documented = new Map(
      Object.entries(createOpenApiDocument().paths).flatMap(([path, item]) =>
        (["get", "post", "patch", "put", "delete"] as const).flatMap((method) => {
          const operation = item[method];
          return operation === undefined
            ? []
            : [[operation.operationId, routeActionKey(method, path)] as const];
        })
      )
    );
    const covered = new Set<string>();
    for (const operation of contract.operations) {
      const key = routeActionKey(operation.method, operation.path);
      expect(registered.has(key), `${operation.operationId}: ${key}`).toBe(true);
      expect(documented.get(operation.operationId), operation.operationId).toBe(key);
      expect(covered.has(key), `duplicate CLI operation: ${key}`).toBe(false);
      covered.add(key);
    }
    expect(
      routes
        .filter((route) => !covered.has(routeActionKey(route.method, route.path)))
        .map((route) => `${route.method} ${route.path}`)
        .sort()
    ).toEqual([
      "DELETE /admin/onboarding-allowlist/:id",
      "GET /admin/onboarding-allowlist",
      "POST /admin/onboarding-allowlist",
    ]);
  });
});
