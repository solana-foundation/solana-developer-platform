import { type Action, apiKeyMayPerform, isAction } from "@sdp/types/actions";
import { type MovementOf, movementActions } from "@sdp/types/movements";
import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { registeredRouteAuthorizations } from "@/routes/route-actions";
import { earnPostRouteMovement } from "./exits";

/**
 * A start names the actions that may sign it, and the signing waist refuses a
 * principal holding none of them (HOO-2099). A route declaring another action
 * admits a caller the waist refuses only after sponsorship, a provider build
 * and a simulation. So every Earn route `exits.ts` files with a start declares
 * an action that start admits.
 */

interface EarnStartRoute {
  route: string;
  movement: MovementOf<"earn">;
  actions: readonly Action[];
  declared: string | undefined;
}

/** A concrete path for a route pattern, so the lookup sees what a request sees. */
function samplePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, "sample_id");
}

function earnStartRoutes(): EarnStartRoute[] {
  const app = createApp({ rampProviderStages: SDP_RAMP_PROVIDER_STAGES });
  return registeredRouteAuthorizations(app).flatMap(({ method, path, declarations }) => {
    if (method !== "POST") return [];
    const movement = earnPostRouteMovement(samplePath(path));
    if (movement === undefined || movement === "read") return [];
    const actions = movementActions(movement);
    if (actions === null) return [];
    const [declaration] = declarations;
    const declared =
      declarations.length === 1 && declaration?.kind === "action" ? declaration.action : undefined;
    return [{ route: `${method} ${path}`, movement, actions, declared }];
  });
}

/** Whether an API key holding only the route's action passes the waist, as `decidePrincipal` asks. */
function waistAdmits({ actions, declared }: EarnStartRoute): boolean {
  return (
    declared !== undefined &&
    isAction(declared) &&
    actions.some((action) => apiKeyMayPerform([declared], action))
  );
}

describe("Earn routes declare an action their movement admits (HOO-2099)", () => {
  const routes = earnStartRoutes();

  it("finds the custody routes that sign a start", () => {
    expect(routes.map(({ route }) => route)).toEqual(
      expect.arrayContaining([
        "POST /v1/earn/vault-deposits",
        "POST /v1/earn/vault-withdrawal-requests/:withdrawalRequestId/cancel",
      ])
    );
  });

  it("declares an action each start admits", () => {
    expect(
      routes
        .filter((route) => !waistAdmits(route))
        .map(
          ({ route, movement, actions, declared }) =>
            `${route} declares ${declared ?? "no single action"}; ${movement} admits ${actions.join(", ")}`
        )
    ).toEqual([]);
  });
});
