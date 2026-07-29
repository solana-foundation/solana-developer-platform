import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKFLOW_ACTION_TYPES, WORKFLOW_TRIGGER_TYPES, type WorkflowActionType } from "@sdp/types";

import {
  listActionsForAsset,
  resolveWorkflowAction,
  resolveWorkflowTrigger,
  validateActionSupported,
  WORKFLOW_ACTIONS,
} from "./index";

describe("workflow catalog", () => {
  // Pins the Phase 5 locked decisions: the net catalog is exactly 13 actions and
  // 6 triggers. The completeness loops below would pass trivially if a type AND its
  // entry were both deleted — the counts make that a loud failure instead.
  it("pins the net catalog size", () => {
    assert.equal(WORKFLOW_ACTION_TYPES.length, 13);
    assert.equal(WORKFLOW_TRIGGER_TYPES.length, 6);
  });

  it("keeps the dropped catalog entries dropped", () => {
    // create_approval_task / approval_decided were removed in favor of the built-in
    // review flow (re-introduced only with the deferred workflow-tasks system).
    assert.equal(resolveWorkflowAction("create_approval_task"), undefined);
    assert.equal(resolveWorkflowTrigger("approval_decided"), undefined);
  });

  it("has an entry for every trigger type", () => {
    for (const type of WORKFLOW_TRIGGER_TYPES) {
      assert.ok(resolveWorkflowTrigger(type), `missing trigger entry: ${type}`);
    }
  });

  it("has an entry for every action type", () => {
    for (const type of WORKFLOW_ACTION_TYPES) {
      assert.ok(resolveWorkflowAction(type), `missing action entry: ${type}`);
    }
  });

  it("marks destructive/irreversible actions as requires_approval and non-idempotent", () => {
    for (const type of ["seize", "force_burn", "burn", "mint"] as WorkflowActionType[]) {
      assert.equal(WORKFLOW_ACTIONS[type].execution, "requires_approval", type);
      assert.equal(WORKFLOW_ACTIONS[type].idempotent, false, type);
    }
  });

  it("marks allowlist add/remove as automated + idempotent (safe manual retry)", () => {
    for (const type of ["allowlist_add", "allowlist_remove"] as WorkflowActionType[]) {
      assert.equal(WORKFLOW_ACTIONS[type].execution, "automated", type);
      assert.equal(WORKFLOW_ACTIONS[type].idempotent, true, type);
    }
  });
});

describe("validateActionSupported (capability gate)", () => {
  const base = { category: "generic" as const, type: "generic" };

  it("rejects an unknown action", () => {
    const result = validateActionSupported({
      ...base,
      action: "not_a_real_action" as WorkflowActionType,
      selectedSettings: {},
      hasAllowlist: true,
    });
    assert.deepEqual(result, { ok: false, reason: "unknown_action" });
  });

  it("allows allowlist_add only when the token has an allowlist", () => {
    assert.deepEqual(
      validateActionSupported({
        ...base,
        action: "allowlist_add",
        selectedSettings: {},
        hasAllowlist: true,
      }),
      { ok: true }
    );
    assert.deepEqual(
      validateActionSupported({
        ...base,
        action: "allowlist_add",
        selectedSettings: {},
        hasAllowlist: false,
      }),
      { ok: false, reason: "no_allowlist" }
    );
  });

  it("gates pause on the freezeTransfers setting being enabled", () => {
    // freezeTransfers unlocks pause/unpause/freeze/unfreeze.
    assert.deepEqual(
      validateActionSupported({
        ...base,
        action: "pause",
        selectedSettings: { freezeTransfers: {} },
        hasAllowlist: false,
      }),
      { ok: true }
    );
    assert.deepEqual(
      validateActionSupported({
        ...base,
        action: "pause",
        selectedSettings: {},
        hasAllowlist: false,
      }),
      { ok: false, reason: "capability_disabled" }
    );
  });

  it("gates seize on the permanentDelegate setting being enabled", () => {
    assert.deepEqual(
      validateActionSupported({
        ...base,
        action: "seize",
        selectedSettings: { permanentDelegate: {} },
        hasAllowlist: false,
      }),
      { ok: true }
    );
    assert.deepEqual(
      validateActionSupported({
        ...base,
        action: "seize",
        selectedSettings: {},
        hasAllowlist: false,
      }),
      { ok: false, reason: "capability_disabled" }
    );
  });

  it("treats base ops (mint/burn) and side-effects (notify) as always supported", () => {
    for (const action of ["mint", "burn", "notify", "record"] as WorkflowActionType[]) {
      assert.deepEqual(
        validateActionSupported({ ...base, action, selectedSettings: {}, hasAllowlist: false }),
        { ok: true },
        action
      );
    }
  });
});

describe("listActionsForAsset", () => {
  it("annotates every action with a support verdict", () => {
    const available = listActionsForAsset({
      category: "generic",
      type: "generic",
      selectedSettings: { freezeTransfers: {} },
      hasAllowlist: true,
    });
    assert.equal(available.length, WORKFLOW_ACTION_TYPES.length);
    const byType = new Map(available.map((a) => [a.type, a.support]));
    assert.deepEqual(byType.get("allowlist_add"), { ok: true });
    assert.deepEqual(byType.get("pause"), { ok: true });
    assert.deepEqual(byType.get("seize"), { ok: false, reason: "capability_disabled" });
  });
});
