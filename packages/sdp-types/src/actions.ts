/**
 * Actions: what a caller may do, by module (HOO-2099).
 *
 * Every API route declares exactly one action, `module.verb`, and every caller
 * either holds it or is refused with a 403 that names it. An API key holds an
 * explicit list of grants; a signed-in member holds the actions of their
 * organization role. There is no wildcard and no stored role.
 *
 * Verbs:
 * - `read`: view.
 * - `manage`: create or edit SDP rows, reversibly (drafts, pause, cancel).
 * - `execute`: irreversible or leaves SDP: on-chain, provider calls, money
 *   movement, and anything that changes where money goes (a recurring
 *   payment's amount or destination, a counterparty's payout destination).
 * - `configure`: provider, credential or connection setup.
 * - `enforce` (issuance): freeze, pause, seize, force-burn, allowlist.
 * - `authority` (issuance): transfer or revoke a token's authorities.
 *
 * `manage` and `execute` each imply the module's `read`. Nothing implies across
 * verbs or modules.
 *
 * Evolution: an action is never renamed or removed silently. When one splits,
 * its old name goes into {@link ACTION_ALIASES} with every piece, so a stored
 * grant keeps what it meant. A brand-new action is granted to no existing key:
 * keys store explicit lists, and "everything" in the dashboard is written out
 * as that list when the key is created.
 */

import type { SdpModule } from "./release-channels";
import type { OrganizationRole } from "./roles";

export const ACTION_VERBS = [
  "read",
  "manage",
  "execute",
  "configure",
  "enforce",
  "authority",
] as const;

export type ActionVerb = (typeof ACTION_VERBS)[number];

/** Where an action module's routes run: a release-channel module, or `core` (every channel). */
export type ActionOwner = SdpModule | "core";

/**
 * The registry: each action module, the release-channel module that owns it,
 * and the verbs it has. Module names follow the `/v1` mounts. Verb order is
 * the order the dashboard shows.
 *
 * Modules outside the Mainnet V1 release (issuance, dvp, earn,
 * private_channels, helius_rings, onramp, offramp, ramp_transfers) carry
 * a coarse mapping: GET is `read`, a mutation is `manage`, `execute` or
 * `configure` by the rule above. Review each before its module is promoted.
 */
export const ACTION_MODULES = {
  // Payments (V1)
  transfers: { owner: "payments", verbs: ["read", "execute"] },
  transfer_batches: { owner: "payments", verbs: ["read", "execute"] },
  payment_requests: { owner: "payments", verbs: ["read", "manage"] },
  counterparties: { owner: "payments", verbs: ["read", "manage", "execute"] },
  transactions: { owner: "payments", verbs: ["read"] },
  // Recurring payments (V1)
  recurring: { owner: "recurring_payments", verbs: ["read", "manage", "execute"] },
  // Custody (V1)
  wallets: { owner: "custody", verbs: ["read", "manage", "execute", "configure"] },
  // Compliance (V1)
  compliance: { owner: "compliance", verbs: ["execute"] },
  // Core administration
  api_keys: { owner: "core", verbs: ["read", "manage"] },
  projects: { owner: "core", verbs: ["read", "manage"] },
  members: { owner: "core", verbs: ["read", "manage"] },
  organizations: { owner: "core", verbs: ["read", "manage"] },
  // Coarse, review before promotion.
  onramp: { owner: "ramps", verbs: ["read", "execute"] },
  offramp: { owner: "ramps", verbs: ["read", "execute"] },
  ramp_transfers: { owner: "ramps", verbs: ["manage"] },
  issuance: {
    owner: "issuance",
    verbs: ["read", "manage", "execute", "enforce", "authority"],
  },
  dvp: { owner: "dvp", verbs: ["read", "manage", "execute"] },
  earn: { owner: "earn", verbs: ["read", "manage", "execute"] },
  private_channels: {
    owner: "private_channels",
    verbs: ["read", "manage", "execute", "configure"],
  },
  helius_rings: { owner: "helius_rings", verbs: ["read", "manage", "execute", "configure"] },
} as const satisfies Record<string, { owner: ActionOwner; verbs: readonly ActionVerb[] }>;

export type ActionModule = keyof typeof ACTION_MODULES;

/** Distributes over a union of modules, so no verb crosses into another module. */
type ActionOfModule<M extends ActionModule> = M extends ActionModule
  ? `${M}.${(typeof ACTION_MODULES)[M]["verbs"][number]}`
  : never;

/** One `module.verb`, for every module and each of its verbs. */
export type Action = ActionOfModule<ActionModule>;

// SAFETY: the keys of a const object literal are exactly its key union.
export const ACTION_MODULE_NAMES = Object.keys(ACTION_MODULES) as ActionModule[];

/** Modules whose action mapping is coarse and must be reviewed before promotion. */
export const COARSE_ACTION_MODULES = [
  "onramp",
  "offramp",
  "ramp_transfers",
  "issuance",
  "dvp",
  "earn",
  "private_channels",
  "helius_rings",
] as const satisfies readonly ActionModule[];

function actionsOfModule<M extends ActionModule>(module: M): ActionOfModule<M>[] {
  // SAFETY: the template literal is exactly `${module}.${verb}` for a verb of this module.
  return ACTION_MODULES[module].verbs.map((verb) => `${module}.${verb}` as ActionOfModule<M>);
}

/** Every action, in registry order. */
export const ACTIONS: readonly Action[] = ACTION_MODULE_NAMES.flatMap((module) =>
  actionsOfModule(module)
);

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

export function isAction(value: string): value is Action {
  return ACTION_SET.has(value);
}

export function actionModuleOf(action: Action): ActionModule {
  // SAFETY: every action is `${module}.${verb}` for a registry module.
  return action.slice(0, action.indexOf(".")) as ActionModule;
}

export function actionVerbOf(action: Action): ActionVerb {
  // SAFETY: every action is `${module}.${verb}` for a verb in ACTION_VERBS.
  return action.slice(action.indexOf(".") + 1) as ActionVerb;
}

/**
 * The release-channel module (or `core`) an action's routes run under. A
 * route inside another module's mount (submitting a counterparty's ramp
 * requirements) is gated by that mount's `requireModule`, not by its action,
 * so a stable key can still hold the action for the stable routes.
 */
export function actionOwnerOf(action: Action): ActionOwner {
  return ACTION_MODULES[actionModuleOf(action)].owner;
}

/**
 * Whether a deployment runs `action`: a core action always, a module's action
 * when `isModuleInChannel` admits its module. Each caller passes its own
 * channel's module predicate.
 */
export function isActionInReleaseChannel(
  action: Action,
  isModuleInChannel: (module: SdpModule) => boolean
): boolean {
  const owner = actionOwnerOf(action);
  return owner === "core" || isModuleInChannel(owner);
}

/** The actions of one module, in the registry's verb order. */
export function actionsInModule(module: ActionModule): Action[] {
  return actionsOfModule(module);
}

function isApiKeyForbiddenAction(action: Action): boolean {
  const module = actionModuleOf(action);
  return (
    module === "api_keys" ||
    module === "members" ||
    action === "organizations.manage" ||
    action === "projects.manage" ||
    actionVerbOf(action) === "configure"
  );
}

/**
 * Actions an API key may never hold: key, member, organization and project
 * administration, and every provider or credential setup. Key create and
 * update refuse them, and authorization refuses them for a key even when a
 * stored row names one.
 */
export const API_KEY_FORBIDDEN_ACTIONS: readonly Action[] = ACTIONS.filter(isApiKeyForbiddenAction);

/** Every action an API key may hold. */
export const API_KEY_GRANTABLE_ACTIONS: readonly Action[] = ACTIONS.filter(
  (action) => !isApiKeyForbiddenAction(action)
);

/**
 * Action modules of the families kept out of every public surface
 * (organization administration; see AGENTS.md, "Public vs internal
 * surfaces"): the public OpenAPI document, its grant enum, the docs and the
 * AI resources never name their actions. Keys may still hold them.
 */
export const HIDDEN_ACTION_MODULES = ["organizations"] as const satisfies readonly ActionModule[];

const HIDDEN_ACTION_MODULE_SET: ReadonlySet<ActionModule> = new Set(HIDDEN_ACTION_MODULES);

export function isHiddenAction(action: Action): boolean {
  return HIDDEN_ACTION_MODULE_SET.has(actionModuleOf(action));
}

export function isApiKeyGrantableAction(action: Action): boolean {
  return !isApiKeyForbiddenAction(action);
}

/**
 * Old action names that split, each with every piece it became. A stored
 * grant naming one expands to all of them, so a split never narrows or widens
 * what an existing key may do. Empty until the first split.
 */
export const ACTION_ALIASES: Readonly<Record<string, readonly Action[]>> = {};

/**
 * The grants a key holds, from its stored column: aliases expanded, unknown
 * strings dropped (they grant nothing: fail closed), deduped, in registry
 * order.
 */
export function expandStoredGrants(stored: readonly string[]): Action[] {
  const held = new Set<Action>();
  for (const value of stored) {
    if (isAction(value)) {
      held.add(value);
      continue;
    }
    // Own keys only: a stored "constructor" or "__proto__" must grant nothing,
    // not reach Object.prototype.
    const pieces = Object.hasOwn(ACTION_ALIASES, value) ? ACTION_ALIASES[value] : undefined;
    for (const piece of pieces ?? []) {
      held.add(piece);
    }
  }
  return ACTIONS.filter((action) => held.has(action));
}

/** Stable storage form of a grant list: unique, in registry order. */
export function normalizeGrants(grants: readonly Action[]): Action[] {
  const held = new Set(grants);
  return ACTIONS.filter((action) => held.has(action));
}

/**
 * Whether a list of grants covers an action: the action itself, or, for a
 * `read`, the same module's `manage` or `execute`.
 */
export function grantsCoverAction(grants: readonly Action[], action: Action): boolean {
  if (grants.includes(action)) {
    return true;
  }
  if (actionVerbOf(action) !== "read") {
    return false;
  }
  const module = actionModuleOf(action);
  return grants.some(
    (grant) =>
      actionModuleOf(grant) === module &&
      (actionVerbOf(grant) === "manage" || actionVerbOf(grant) === "execute")
  );
}

/**
 * Whether an API key holding these grants may perform the action. A forbidden
 * action is refused even when a stored row names it.
 */
export function apiKeyMayPerform(grants: readonly Action[], action: Action): boolean {
  return isApiKeyGrantableAction(action) && grantsCoverAction(grants, action);
}

/**
 * Actions an organization `member` does not hold: key, member, organization
 * and project administration, every `configure`, and the actions whose routes
 * were organization-admin-only before actions existed (issuance `enforce` and
 * `authority` were `tokens:admin`; wallet lifecycle was `custody:admin`, and
 * `wallets.execute` now covers deleting a wallet at its custody provider, so
 * the signer check that shares it goes admin-only with it).
 */
function isAdminOnlyAction(action: Action): boolean {
  return (
    action === "api_keys.manage" ||
    action === "members.manage" ||
    action === "organizations.manage" ||
    action === "projects.manage" ||
    action === "issuance.enforce" ||
    action === "issuance.authority" ||
    action === "wallets.manage" ||
    action === "wallets.execute" ||
    actionVerbOf(action) === "configure"
  );
}

/** The actions a signed-in person holds through their organization role. */
export const ORGANIZATION_ROLE_ACTIONS = {
  admin: ACTIONS,
  member: ACTIONS.filter((action) => !isAdminOnlyAction(action)),
} as const satisfies Record<OrganizationRole, readonly Action[]>;

export function organizationRoleMayPerform(role: OrganizationRole, action: Action): boolean {
  return ORGANIZATION_ROLE_ACTIONS[role].includes(action);
}
