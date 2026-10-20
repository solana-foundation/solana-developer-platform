import {
  type Action,
  type ActionModule,
  type ActionVerb,
  API_KEY_GRANTABLE_ACTIONS,
  actionModuleOf,
  actionVerbOf,
  grantsCoverAction,
  isAction,
  isActionInReleaseChannel,
  normalizeGrants,
} from "@sdp/types/actions";
import type { ApiKeyEnvironment, ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { SdpModule } from "@sdp/types/release-channels";

export const API_KEY_AUTHORING_STEPS = ["details", "permissions", "wallets", "review"] as const;

export type ApiKeyAuthoringStep = (typeof API_KEY_AUTHORING_STEPS)[number];
export type ApiKeyAuthoringMode = "create" | "edit";

export interface ApiKeyAuthoringDraft {
  name: string;
  expiresAt: string;
  walletScope: ApiKeyWalletScope;
  /** Custody wallet ids (`custody_wallets.id`) a selected key may sign with. */
  selectedWalletIds: string[];
  /** The key's explicit grants, in registry order. */
  grants: Action[];
  /** The key's IP allowlist as typed: one address or CIDR range per line. */
  allowedIps: string;
}

export interface ApiKeyAuthoringExistingKey {
  id: string;
  name: string;
  environment: ApiKeyEnvironment;
  grants: Action[];
  expiresAt: string | null;
  walletScope: ApiKeyWalletScope;
  /** Custody wallet ids a selected key lists. */
  walletIds: string[];
  /** Null: the key may be used from any address. */
  allowedIps: string[] | null;
}

export function createApiKeyAuthoringDraft(): ApiKeyAuthoringDraft {
  return {
    name: "",
    expiresAt: "",
    walletScope: "all",
    selectedWalletIds: [],
    grants: [],
    allowedIps: "",
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
  return API_KEY_GRANTABLE_ACTIONS.filter((action) =>
    isActionInReleaseChannel(action, isModuleInChannel)
  );
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
 * Drops a module's `read` wherever the same module's `manage` or `execute` is
 * held: it is included, so storing it too would only make the list noisier.
 */
function withoutIncludedReads(grants: readonly Action[]): Action[] {
  return normalizeGrants(
    grants.filter(
      (grant) =>
        actionVerbOf(grant) !== "read" ||
        !grantsCoverAction(
          grants.filter((other) => other !== grant),
          grant
        )
    )
  );
}

/**
 * Turns one action on or off. Each verb is its own toggle, so a module can
 * hold both `manage` and `execute`. `read` is never stored next to the
 * module's `manage` or `execute`, which include it; an included read cannot
 * be turned off on its own. Turning off a module's last `manage` or
 * `execute` leaves its `read`: unticking a write narrows the key to reading
 * that module rather than dropping it. Other verbs (issuance `enforce` and
 * `authority`) include nothing, so a read stays next to them.
 */
export function toggleGrant(grants: readonly Action[], action: Action): Action[] {
  const module = actionModuleOf(action);
  if (grants.includes(action)) {
    const next = grants.filter((grant) => grant !== action);
    const read = `${module}.read`;
    if (
      action !== read &&
      isAction(read) &&
      API_KEY_GRANTABLE_ACTIONS.includes(read) &&
      grantsCoverAction(grants, read) &&
      !grantsCoverAction(next, read)
    ) {
      return normalizeGrants([...next, read]);
    }
    return next;
  }
  return withoutIncludedReads([...grants, action]);
}

/**
 * The held grants this deployment does not offer (a module its release
 * channel no longer runs). The picker cannot tick them, so it shows them
 * read-only and keeps them through "Everything" and "Clear all"; the API
 * accepts a grant the key already holds even when it is out of channel.
 */
export function heldGrantsNotOffered(
  grants: readonly Action[],
  offered: readonly Action[]
): Action[] {
  return normalizeGrants(grants.filter((grant) => !offered.includes(grant)));
}

/** Clears every grant on one module. */
export function clearModuleGrants(grants: readonly Action[], module: ActionModule): Action[] {
  return grants.filter((grant) => actionModuleOf(grant) !== module);
}

/** "Clear all": every offered grant off; ones the picker cannot show are kept. */
export function clearOfferedGrants(
  grants: readonly Action[],
  offered: readonly Action[]
): Action[] {
  return heldGrantsNotOffered(grants, offered);
}

/**
 * "Everything": every offered action, written out. Reads a module's
 * `manage` or `execute` includes are not stored, and grants the picker cannot
 * show are kept. What is stored is this explicit list, so an action added to
 * SDP later reaches no existing key.
 */
export function everythingGrants(
  offered: readonly Action[],
  current: readonly Action[] = []
): Action[] {
  return withoutIncludedReads([...offered, ...heldGrantsNotOffered(current, offered)]);
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

/** Whether any grant lets the key move money or sign (an `execute` action). */
export function grantsIncludeExecute(grants: readonly Action[]): boolean {
  return grants.some((grant) => actionVerbOf(grant) === "execute");
}

/**
 * The wallet scope a new key starts with, until the person picks one: a key
 * that can execute starts on Selected wallets, so it signs with nothing it
 * was not given (HOO-2099); a read-only key starts on All.
 */
export function defaultWalletScopeForGrants(grants: readonly Action[]): ApiKeyWalletScope {
  return grantsIncludeExecute(grants) ? "selected" : "all";
}

export type EndpointWalletPayload =
  | { walletScope: "all" }
  | { walletScope: "selected"; walletIds: string[] };

/** The API's wallet fields: the scope, and for a selected key its custody wallet ids. */
export function buildEndpointWalletPayload(draft: ApiKeyAuthoringDraft): EndpointWalletPayload {
  if (draft.walletScope === "all") {
    return { walletScope: "all" };
  }
  return { walletScope: "selected", walletIds: Array.from(new Set(draft.selectedWalletIds)) };
}

/** Whether the draft has what a step needs before the next one opens. */
export function isAuthoringStepComplete(
  step: ApiKeyAuthoringStep,
  draft: ApiKeyAuthoringDraft
): boolean {
  switch (step) {
    case "details":
      return draft.name.trim().length > 0;
    case "permissions":
      return draft.grants.length > 0;
    case "wallets":
      return draft.walletScope === "all" || draft.selectedWalletIds.length > 0;
    case "review":
      return true;
    default: {
      const unknownStep: never = step;
      throw new Error(`Unknown API-key authoring step: ${String(unknownStep)}`);
    }
  }
}
