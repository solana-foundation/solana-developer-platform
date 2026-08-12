// Workflow rules are a second path to the same on-chain operations the direct token
// routes gate on `tokens:admin` (seize, force-burn, pause/unpause, freeze/unfreeze).
// Without this, a `tokens:write` member who is 403'd on POST /tokens/:id/seize could
// author a seize rule and approve it — the same operation, one hop removed.
//
// The permission required is derived from the action's execution tier, so harmless
// automations stay available to members and privileged actions match the direct routes.

import { resolveWorkflowAction } from "@sdp/issuance/workflows";
import type { Permission } from "@sdp/types";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { AppContext } from "../helpers";

export function permissionForWorkflowAction(actionType: string): Permission {
  // Unknown types fall to the strict side; the caller validates the type separately and
  // rejects it, but an authorization default must never be the permissive one.
  return resolveWorkflowAction(actionType)?.execution === "automated"
    ? "tokens:write"
    : "tokens:admin";
}

// Throws the same INSUFFICIENT_PERMISSIONS error shape as the `requirePermissions`
// middleware, so clients handle a tier rejection exactly like a route-level one.
export function assertWorkflowActionPermitted(c: AppContext, actionType: string): void {
  const required = permissionForWorkflowAction(actionType);
  const { permissions } = getAuth(c);
  if (permissions.includes("*") || permissions.includes(required)) {
    return;
  }
  throw new AppError("INSUFFICIENT_PERMISSIONS", `Required permissions: ${required}`);
}
