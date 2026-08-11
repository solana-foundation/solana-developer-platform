import {
  type SelectedSetting,
  TOKEN_TRANSACTION_TYPES,
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_TRIGGER_TYPES,
  type WorkflowAction,
  type WorkflowActionType,
  type WorkflowTrigger,
  type WorkflowTriggerType,
} from "@sdp/types";
import { WORKFLOW_ACTIONS } from "./actions";
import { type ActionSupportResult, validateActionSupported } from "./resolver";
import { WORKFLOW_TRIGGERS } from "./triggers";

export { WORKFLOW_ACTIONS } from "./actions";
export {
  type ActionSupportResult,
  type ActionUnsupportedReason,
  type ValidateActionInput,
  validateActionSupported,
} from "./resolver";
export { WORKFLOW_TRIGGERS } from "./triggers";

/** The version stamped onto a stored rule's definition; bump if the shape changes. */
export const WORKFLOW_RULE_VERSION = 1;

/**
 * Looks up a trigger's catalog entry by type.
 * @param type - Trigger type identifier.
 * @returns The catalog entry, or undefined if the type is unknown.
 */
export function resolveWorkflowTrigger(type: string): WorkflowTrigger | undefined {
  return (WORKFLOW_TRIGGERS as Record<string, WorkflowTrigger>)[type];
}

/**
 * Looks up an action's catalog entry by type.
 * @param type - Action type identifier.
 * @returns The catalog entry, or undefined if the type is unknown.
 */
export function resolveWorkflowAction(type: string): WorkflowAction | undefined {
  return (WORKFLOW_ACTIONS as Record<string, WorkflowAction>)[type];
}

export interface CatalogTrigger {
  type: WorkflowTriggerType;
  trigger: WorkflowTrigger;
}

/**
 * Lists every trigger in the catalog.
 * @returns Every trigger type paired with its catalog entry.
 */
export function listTriggers(): CatalogTrigger[] {
  return WORKFLOW_TRIGGER_TYPES.map((type) => ({ type, trigger: WORKFLOW_TRIGGERS[type] }));
}

export interface CatalogAction {
  type: WorkflowActionType;
  action: WorkflowAction;
}

/**
 * Lists every action in the catalog.
 * @returns Every action type paired with its catalog entry.
 */
export function listActions(): CatalogAction[] {
  return WORKFLOW_ACTION_TYPES.map((type) => ({ type, action: WORKFLOW_ACTIONS[type] }));
}

export interface AvailableAction extends CatalogAction {
  support: ActionSupportResult;
}

/**
 * Lists every action annotated with whether *this* asset supports it. Powers
 * the "available for this asset" API endpoint and the wizard's "automations
 * you'll unlock" preview.
 * @param input - The asset's capability state to validate each action against.
 * @returns Every action type paired with its catalog entry and support verdict.
 */
export function listActionsForAsset(input: {
  selectedSettings: Record<string, SelectedSetting>;
  hasAllowlist: boolean;
  isMintable?: boolean;
}): AvailableAction[] {
  return WORKFLOW_ACTION_TYPES.map((type) => ({
    type,
    action: WORKFLOW_ACTIONS[type],
    support: validateActionSupported({ action: type, ...input }),
  }));
}

/**
 * Dev-time assertion: catalog completeness + requirement integrity. Also
 * enforces that irreversible ops (seize, force_burn, burn, mint) are always
 * tier "requires_approval" and can never be auto-runnable.
 */
if (process.env.NODE_ENV !== "production") {
  const tokenTxns = new Set<string>(TOKEN_TRANSACTION_TYPES);

  for (const type of WORKFLOW_TRIGGER_TYPES) {
    if (!WORKFLOW_TRIGGERS[type]) {
      throw new Error(
        `workflows: trigger "${type}" is in WORKFLOW_TRIGGER_TYPES but has no catalog entry.`
      );
    }
  }

  for (const type of WORKFLOW_ACTION_TYPES) {
    const action = WORKFLOW_ACTIONS[type];
    if (!action) {
      throw new Error(
        `workflows: action "${type}" is in WORKFLOW_ACTION_TYPES but has no catalog entry.`
      );
    }
    const requires = action.requires;
    if (
      (requires.kind === "token_transaction" || requires.kind === "native") &&
      !tokenTxns.has(requires.action)
    ) {
      throw new Error(
        `workflows: action "${type}" requires unknown token transaction "${requires.action}". ` +
          `Known: ${TOKEN_TRANSACTION_TYPES.join(", ")}`
      );
    }
    if (
      (type === "seize" || type === "force_burn" || type === "burn" || type === "mint") &&
      action.execution !== "requires_approval"
    ) {
      throw new Error(`workflows: destructive action "${type}" must be tier "requires_approval".`);
    }
  }
}
