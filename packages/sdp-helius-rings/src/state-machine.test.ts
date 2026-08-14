import { describe, expect, it } from "vitest";
import { failEdgeFor, nextState, TRANSITIONS, type TransitionGuard } from "./state-machine";
import type { OperationState } from "./types";

const TERMINAL_STATES: OperationState[] = ["completed", "failed"];
const NON_TERMINAL_WITHOUT_FAIL_EDGE: OperationState[] = ["draft"];

describe("nextState", () => {
  it("advances draft to preparing without a guard", () => {
    expect(nextState("draft")).toBe("preparing");
    expect(nextState("draft", undefined)).toBe("preparing");
  });

  it("advances every guarded transition when the guard matches", () => {
    const guarded = TRANSITIONS.filter((t) => t.guard);
    for (const transition of guarded) {
      expect(nextState(transition.from, transition.guard)).toBe(transition.to);
    }
  });

  it("returns null for an unmatched guard on a guarded transition", () => {
    expect(nextState("preparing")).toBeNull();
    expect(nextState("preparing", "signed")).toBeNull();
    expect(nextState("approval_required", "policy_ok")).toBeNull();
  });

  it("returns null for illegal transitions", () => {
    expect(nextState("draft", "signed" as TransitionGuard)).toBeNull();
    expect(nextState("proving", "policy_ok")).toBeNull();
    expect(nextState("ready_to_sign", "approved")).toBeNull();
  });

  it("returns null from every terminal state", () => {
    for (const state of TERMINAL_STATES) {
      expect(nextState(state)).toBeNull();
      expect(nextState(state, "signed")).toBeNull();
    }
  });

  it("forbids reaching proving without going through approval_required", () => {
    expect(nextState("preparing", "approved")).toBeNull();
    expect(nextState("preparing", "policy_ok")).toBe("approval_required");
    expect(nextState("approval_required", "approved")).toBe("proving");
  });
});

describe("failEdgeFor", () => {
  it("returns the retryable-flag correctly for each defined fail edge", () => {
    expect(failEdgeFor("preparing")).toEqual({ code: "policy_denied", retryable: false });
    expect(failEdgeFor("approval_required")).toEqual({
      code: "approval_rejected",
      retryable: false,
    });
    expect(failEdgeFor("proving")).toEqual({ code: "proof_failed", retryable: true });
    expect(failEdgeFor("ready_to_sign")).toEqual({ code: "signer_failed", retryable: true });
    expect(failEdgeFor("submitted")).toEqual({ code: "submit_failed", retryable: true });
    expect(failEdgeFor("indexing")).toEqual({ code: "indexing_timeout", retryable: true });
  });

  it("returns null from terminal states and from draft", () => {
    for (const state of [...TERMINAL_STATES, ...NON_TERMINAL_WITHOUT_FAIL_EDGE]) {
      expect(failEdgeFor(state)).toBeNull();
    }
  });
});
