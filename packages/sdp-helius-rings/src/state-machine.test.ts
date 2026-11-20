import { describe, expect, it } from "vitest";
import { failEdgeFor, nextState, TRANSITIONS, type TransitionGuard } from "./state-machine";
import type { OperationState } from "./types";

const TERMINAL_STATES: OperationState[] = ["completed", "failed"];
const NON_TERMINAL_WITHOUT_FAIL_EDGE: OperationState[] = ["draft", "preparing"];

describe("nextState", () => {
  it("advances draft to preparing without a guard", () => {
    expect(nextState("draft")).toBe("preparing");
    expect(nextState("draft", undefined)).toBe("preparing");
  });

  it("advances every guarded transition when the guard matches", () => {
    // Each edge's target is pinned as a literal, not read back from
    // TRANSITIONS: nextState answers out of that same table, so iterating it
    // would bless a rewired edge (e.g. proving jumping straight to completed,
    // past signing) as long as the table stayed self-consistent.
    const pinnedEdges: ReadonlyArray<{
      from: OperationState;
      guard: TransitionGuard;
      to: OperationState;
    }> = [
      { from: "preparing", guard: "prepared", to: "proving" },
      { from: "proving", guard: "proof_received", to: "ready_to_sign" },
      { from: "ready_to_sign", guard: "signed", to: "submitted" },
      { from: "submitted", guard: "submitted", to: "indexing" },
      { from: "indexing", guard: "indexed", to: "completed" },
    ];
    // Every guarded transition in the table must be pinned above, so a newly
    // added edge fails here until the flow's required target is written down.
    expect(TRANSITIONS.filter((t) => t.guard)).toHaveLength(pinnedEdges.length);
    for (const edge of pinnedEdges) {
      expect(nextState(edge.from, edge.guard)).toBe(edge.to);
    }
  });

  it("returns null for an unmatched guard on a guarded transition", () => {
    expect(nextState("preparing")).toBeNull();
    expect(nextState("preparing", "signed")).toBeNull();
    expect(nextState("proving", "prepared")).toBeNull();
  });

  it("returns null for illegal transitions", () => {
    expect(nextState("draft", "signed" as TransitionGuard)).toBeNull();
    expect(nextState("proving", "approved" as TransitionGuard)).toBeNull();
    expect(nextState("ready_to_sign", "prepared")).toBeNull();
  });

  it("returns null from every terminal state", () => {
    for (const state of TERMINAL_STATES) {
      expect(nextState(state)).toBeNull();
      expect(nextState(state, "signed")).toBeNull();
    }
  });

  it("moves preparing straight to proving; there is no hold state in between", () => {
    expect(nextState("preparing", "prepared")).toBe("proving");
  });
});

describe("failEdgeFor", () => {
  it("returns the retryable-flag correctly for each defined fail edge", () => {
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
