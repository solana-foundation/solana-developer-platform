import {
  ACTION_ALIASES,
  ACTION_MODULES,
  ACTIONS,
  type Action,
  API_KEY_FORBIDDEN_ACTIONS,
  API_KEY_GRANTABLE_ACTIONS,
  actionModuleOf,
  actionVerbOf,
  apiKeyMayPerform,
  expandStoredGrants,
  grantsCoverAction,
  isAction,
  ORGANIZATION_ROLE_ACTIONS,
  organizationRoleMayPerform,
} from "@sdp/types/actions";
import { describe, expect, it } from "vitest";

/**
 * Every action that has ever been published. Registry evolution rules
 * (HOO-2099): an action is never silently renamed or removed, so one that
 * leaves `ACTIONS` must be an `ACTION_ALIASES` key expanding to its pieces;
 * and a brand-new action reaches no existing key, because a stored grant list
 * only ever expands to the actions it names or their alias pieces. Add new
 * actions here when they ship; never delete a line.
 */
const PUBLISHED_ACTIONS = [
  "transfers.read",
  "transfers.execute",
  "transfer_batches.read",
  "transfer_batches.execute",
  "payment_requests.read",
  "payment_requests.manage",
  "counterparties.read",
  "counterparties.manage",
  "counterparties.execute",
  "transactions.read",
  "recurring.read",
  "recurring.manage",
  "recurring.execute",
  "wallets.read",
  "wallets.manage",
  "wallets.execute",
  "wallets.configure",
  "compliance.execute",
  "api_keys.read",
  "api_keys.manage",
  "projects.read",
  "projects.manage",
  "members.read",
  "members.manage",
  "organizations.read",
  "organizations.manage",
  "rpc.execute",
  "onramp.read",
  "onramp.execute",
  "offramp.read",
  "offramp.execute",
  "ramp_transfers.manage",
  "issuance.read",
  "issuance.manage",
  "issuance.execute",
  "issuance.enforce",
  "issuance.authority",
  "dvp.read",
  "dvp.manage",
  "dvp.execute",
  "earn.read",
  "earn.manage",
  "earn.execute",
  "private_channels.read",
  "private_channels.manage",
  "private_channels.execute",
  "private_channels.configure",
  "helius_rings.read",
  "helius_rings.manage",
  "helius_rings.execute",
  "helius_rings.configure",
] as const;

describe("action registry", () => {
  it("has every published action, or an alias for it", () => {
    const missing = PUBLISHED_ACTIONS.filter(
      (action) => !isAction(action) && ACTION_ALIASES[action] === undefined
    );
    expect(missing).toEqual([]);
  });

  it("publishes every current action (a new action is added to the published list)", () => {
    const published: readonly string[] = PUBLISHED_ACTIONS;
    expect(ACTIONS.filter((action) => !published.includes(action))).toEqual([]);
  });

  it("aliases only retired names, each to current actions", () => {
    for (const [alias, pieces] of Object.entries(ACTION_ALIASES)) {
      expect(isAction(alias), alias).toBe(false);
      expect(pieces.length, alias).toBeGreaterThan(0);
      expect(
        pieces.every((piece) => isAction(piece)),
        alias
      ).toBe(true);
    }
  });

  it("never widens a stored grant beyond what it names or its alias pieces", () => {
    for (const stored of PUBLISHED_ACTIONS) {
      const expanded = expandStoredGrants([stored]);
      const allowed = isAction(stored) ? [stored] : (ACTION_ALIASES[stored] ?? []);
      expect(expanded, stored).toEqual(ACTIONS.filter((action) => allowed.includes(action)));
    }
  });

  it("drops unknown stored strings and the old permission vocabulary", () => {
    expect(expandStoredGrants(["*", "payments:write", "transfers.everything"])).toEqual([]);
  });

  it("grants nothing for stored strings that name Object.prototype members", () => {
    expect(expandStoredGrants(["constructor", "__proto__", "toString", "hasOwnProperty"])).toEqual(
      []
    );
  });

  it("names every action module.verb with a verb its module has", () => {
    for (const action of ACTIONS) {
      const verbs: readonly string[] = ACTION_MODULES[actionModuleOf(action)].verbs;
      expect(verbs.includes(actionVerbOf(action)), action).toBe(true);
    }
  });
});

describe("implication", () => {
  it("lets manage and execute each cover the module's read", () => {
    expect(grantsCoverAction(["recurring.manage"], "recurring.read")).toBe(true);
    expect(grantsCoverAction(["recurring.execute"], "recurring.read")).toBe(true);
  });

  it("implies nothing across verbs", () => {
    expect(grantsCoverAction(["recurring.execute"], "recurring.manage")).toBe(false);
    expect(grantsCoverAction(["recurring.manage"], "recurring.execute")).toBe(false);
    expect(grantsCoverAction(["recurring.read"], "recurring.manage")).toBe(false);
    expect(grantsCoverAction(["issuance.enforce"], "issuance.read")).toBe(false);
    expect(grantsCoverAction(["wallets.configure"], "wallets.read")).toBe(false);
  });

  it("implies nothing across modules", () => {
    expect(grantsCoverAction(["transfers.execute"], "transfer_batches.read")).toBe(false);
    expect(grantsCoverAction(["transfers.execute"], "wallets.read")).toBe(false);
    expect(grantsCoverAction(["counterparties.execute"], "recurring.read")).toBe(false);
  });
});

describe("API key limits", () => {
  it("never lets a key hold key, member, organization or project administration, or configure", () => {
    expect([...API_KEY_FORBIDDEN_ACTIONS].sort()).toEqual(
      [
        "api_keys.read",
        "api_keys.manage",
        "members.read",
        "members.manage",
        "organizations.manage",
        "projects.manage",
        "wallets.configure",
        "private_channels.configure",
        "helius_rings.configure",
      ].sort()
    );
  });

  it("refuses a forbidden action even when the grants name it", () => {
    for (const action of API_KEY_FORBIDDEN_ACTIONS) {
      expect(apiKeyMayPerform([action], action), action).toBe(false);
    }
  });

  it("lets a key hold everything else", () => {
    expect([...API_KEY_GRANTABLE_ACTIONS, ...API_KEY_FORBIDDEN_ACTIONS].sort()).toEqual(
      [...ACTIONS].sort()
    );
  });
});

describe("organization roles", () => {
  it("gives an administrator every action", () => {
    expect(ORGANIZATION_ROLE_ACTIONS.admin).toEqual(ACTIONS);
  });

  it("gives a member everything but administration, configure, and the old admin-only actions", () => {
    const denied: Action[] = ACTIONS.filter(
      (action) => !organizationRoleMayPerform("member", action)
    );
    expect(denied.sort()).toEqual(
      [
        "api_keys.manage",
        "members.manage",
        "organizations.manage",
        "projects.manage",
        "wallets.manage",
        "wallets.execute",
        "wallets.configure",
        "issuance.enforce",
        "issuance.authority",
        "private_channels.configure",
        "helius_rings.configure",
      ].sort()
    );
  });
});
