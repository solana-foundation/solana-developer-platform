// Workflow Builder domain: trigger/action catalog, capability gate, lookups.
// Mosaic-free (only @sdp/types + the settings catalog), safe for API/web/tests.
// Mirrors @sdp/issuance/capabilities. See Phase 5 plan.

import {
  type AssetCategory,
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
  type ActionSupportReason,
  type ActionSupportResult,
  type ValidateActionInput,
  validateActionSupported,
} from "./resolver";
export { WORKFLOW_TRIGGERS } from "./triggers";

// The version stamped onto a stored rule's definition; bump if the shape changes.
export const WORKFLOW_RULE_VERSION = 1;

export function resolveWorkflowTrigger(type: string): WorkflowTrigger | undefined {
  return (WORKFLOW_TRIGGERS as Record<string, WorkflowTrigger>)[type];
}

export function resolveWorkflowAction(type: string): WorkflowAction | undefined {
  return (WORKFLOW_ACTIONS as Record<string, WorkflowAction>)[type];
}

export interface CatalogTrigger {
  type: WorkflowTriggerType;
  trigger: WorkflowTrigger;
}

export function listTriggers(): CatalogTrigger[] {
  return WORKFLOW_TRIGGER_TYPES.map((type) => ({ type, trigger: WORKFLOW_TRIGGERS[type] }));
}

export interface CatalogAction {
  type: WorkflowActionType;
  action: WorkflowAction;
}

export function listActions(): CatalogAction[] {
  return WORKFLOW_ACTION_TYPES.map((type) => ({ type, action: WORKFLOW_ACTIONS[type] }));
}

export interface AvailableAction extends CatalogAction {
  support: ActionSupportResult;
}

// Actions annotated with whether *this* asset supports them — powers the "available for
// this asset" API endpoint and the wizard's "automations you'll unlock" preview.
export function listActionsForAsset(input: {
  category: AssetCategory;
  type: string;
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

// Dev-time assertion: catalog completeness + requirement integrity.
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
      (requires.kind === "token_transaction" || requires.kind === "base") &&
      !tokenTxns.has(requires.action)
    ) {
      throw new Error(
        `workflows: action "${type}" requires unknown token transaction "${requires.action}". ` +
          `Known: ${TOKEN_TRANSACTION_TYPES.join(", ")}`
      );
    }
    // Irreversible ops must never be auto-runnable.
    if (
      (type === "seize" || type === "force_burn" || type === "burn" || type === "mint") &&
      action.execution !== "requires_approval"
    ) {
      throw new Error(`workflows: destructive action "${type}" must be tier "requires_approval".`);
    }
  }
}
