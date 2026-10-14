import {
  type Action,
  type ActionModule,
  type ActionVerb,
  API_KEY_GRANTABLE_ACTIONS,
  type ApiKeyEnvironment,
  type ApiKeyWalletScope,
  actionModuleOf,
  actionOwnerOf,
  actionVerbOf,
  grantsCoverAction,
  isInEverythingGrant,
  normalizeGrants,
  type SdpModule,
} from "@sdp/types";

export const API_KEY_AUTHORING_STEPS = ["details", "permissions", "wallets", "review"] as const;

export type ApiKeyAuthoringStep = (typeof API_KEY_AUTHORING_STEPS)[number];
export type ApiKeyAuthoringMode = "create" | "edit";

export interface ApiKeyAuthoringDraft {
  name: string;
  expiresAt: string;
  walletScope: ApiKeyWalletScope;
  selectedWalletIds: string[];
  defaultWalletId: string;
  /** The key's explicit grants, in registry order. */
  grants: Action[];
}

export interface ApiKeyAuthoringExistingKey {
  id: string;
  name: string;
  environment: ApiKeyEnvironment;
  grants: Action[];
  expiresAt: string | null;
  walletScope: ApiKeyWalletScope;
  signingWalletId: string | null;
  signingWalletIds: string[];
}

export function createApiKeyAuthoringDraft(): ApiKeyAuthoringDraft {
  return {
    name: "",
    expiresAt: "",
    walletScope: "all",
    selectedWalletIds: [],
    defaultWalletId: "",
    grants: [],
  };
}

/**
 * The actions this deployment lets a key be granted: every grantable action
 * whose routes run in its release channel (`core` always does). Computed on
 * the server, where the channel is known, and passed to the picker.
 */
export function grantableActionsInChannel(
  isModuleInChannel: (module: SdpModule) => boolean
): Action[] {
  return API_KEY_GRANTABLE_ACTIONS.filter((action) => {
    const owner = actionOwnerOf(action);
    return owner === "core" || isModuleInChannel(owner);
  });
}

/** One picker row: a module and the verbs a key may be granted on it here. */
export interface GrantModuleRow {
  module: ActionModule;
  actions: Action[];
}

/** The offered actions grouped by module, in registry order. */
export function grantModuleRows(offered: readonly Action[]): GrantModuleRow[] {
  const rows: GrantModuleRow[] = [];
  for (const action of offered) {
    const module = actionModuleOf(action);
    const row = rows.find((candidate) => candidate.module === module);
    if (row) row.actions.push(action);
    else rows.push({ module, actions: [action] });
  }
  return rows;
}

/** A verb toggle's state: held, included by the module's manage or execute, or off. */
export type GrantToggleState = "on" | "implied" | "off";

export function grantToggleState(grants: readonly Action[], action: Action): GrantToggleState {
  if (grants.includes(action)) return "on";
  return grantsCoverAction(grants, action) ? "implied" : "off";
}

/**
 * Turns one action on or off. Each verb is its own toggle, so a module can
 * hold both `manage` and `execute`. `read` is never stored next to the
 * module's `manage` or `execute`, which include it; an included read cannot
 * be turned off on its own.
 */
export function toggleGrant(grants: readonly Action[], action: Action): Action[] {
  if (grants.includes(action)) {
    return grants.filter((grant) => grant !== action);
  }
  const next = [...grants, action];
  const verb = actionVerbOf(action);
  if (verb === "manage" || verb === "execute") {
    const module = actionModuleOf(action);
    return normalizeGrants(
      next.filter((grant) => !(actionModuleOf(grant) === module && actionVerbOf(grant) === "read"))
    );
  }
  return normalizeGrants(next);
}

/** Clears every grant on one module. */
export function clearModuleGrants(grants: readonly Action[], module: ActionModule): Action[] {
  return grants.filter((grant) => actionModuleOf(grant) !== module);
}

/**
 * "Everything": every offered action, written out, except the metered RPC
 * relay, which a key gets only when it is ticked on its own. What is stored
 * is this explicit list, so an action added to SDP later reaches no existing
 * key.
 */
export function everythingGrants(offered: readonly Action[]): Action[] {
  return normalizeGrants(offered.filter(isInEverythingGrant));
}

/** The verbs held on each module, an included read listed too, for summaries. */
export function summarizeGrants(
  grants: readonly Action[]
): { module: ActionModule; verbs: ActionVerb[] }[] {
  const held = normalizeGrants(grants);
  const rows: { module: ActionModule; verbs: ActionVerb[] }[] = [];
  for (const action of API_KEY_GRANTABLE_ACTIONS) {
    if (!grantsCoverAction(held, action)) continue;
    const module = actionModuleOf(action);
    const row = rows.find((candidate) => candidate.module === module);
    if (row) row.verbs.push(actionVerbOf(action));
    else rows.push({ module, verbs: [actionVerbOf(action)] });
  }
  return rows;
}

export function buildEndpointWalletPayload(draft: ApiKeyAuthoringDraft): {
  walletScope: ApiKeyWalletScope;
  signingWalletId?: string;
  signingWalletIds?: string[];
} {
  if (draft.walletScope === "all") {
    return { walletScope: "all" };
  }

  const selectedWalletIds = Array.from(new Set(draft.selectedWalletIds));
  const signingWalletId = selectedWalletIds.includes(draft.defaultWalletId)
    ? draft.defaultWalletId
    : selectedWalletIds[0];

  return {
    walletScope: "selected",
    signingWalletId,
    signingWalletIds: selectedWalletIds,
  };
}
