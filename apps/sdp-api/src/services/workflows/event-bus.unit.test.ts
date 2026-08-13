import type { WorkflowCondition } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { evaluateCondition } from "./event-bus";

function guard(
  field: string,
  op: "eq" | "neq" | "in",
  value: string | number | Array<string | number>
): WorkflowCondition {
  return { all: [{ field, op, value }] } as WorkflowCondition;
}

describe("evaluateCondition", () => {
  it("matches everything when there is no condition", () => {
    expect(evaluateCondition(null, { provider: "mural" })).toBe(true);
    expect(evaluateCondition(undefined, {})).toBe(true);
  });

  it("matches on an exact value", () => {
    expect(evaluateCondition(guard("provider", "eq", "mural"), { provider: "mural" })).toBe(true);
    expect(evaluateCondition(guard("provider", "eq", "mural"), { provider: "bridge" })).toBe(false);
  });

  // The builder collects guard values as free text while emitters produce real numbers,
  // so a strict comparison made `attempt eq 3` impossible to satisfy.
  it("matches a number payload against a value typed as text", () => {
    expect(evaluateCondition(guard("attempt", "eq", "3"), { attempt: 3 })).toBe(true);
    expect(evaluateCondition(guard("attempt", "eq", 3), { attempt: 3 })).toBe(true);
    expect(evaluateCondition(guard("attempt", "eq", "3"), { attempt: 4 })).toBe(false);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(evaluateCondition(guard("provider", "eq", "Mural"), { provider: "mural" })).toBe(true);
    expect(evaluateCondition(guard("provider", "eq", " mural "), { provider: "mural" })).toBe(true);
  });

  // neq is the dangerous direction: a guard that can never match makes a destructive
  // rule fire on every event instead of the intended subset.
  it("negates consistently with eq", () => {
    expect(evaluateCondition(guard("provider", "neq", "mural"), { provider: "mural" })).toBe(false);
    expect(evaluateCondition(guard("attempt", "neq", "3"), { attempt: 3 })).toBe(false);
    expect(evaluateCondition(guard("provider", "neq", "mural"), { provider: "bridge" })).toBe(true);
  });

  it("treats a missing payload field as not equal", () => {
    expect(evaluateCondition(guard("provider", "eq", "mural"), {})).toBe(false);
    expect(evaluateCondition(guard("provider", "neq", "mural"), {})).toBe(true);
  });

  it("matches any member of an `in` list, with the same leniency", () => {
    const condition = guard("provider", "in", ["mural", "bridge"]);
    expect(evaluateCondition(condition, { provider: "bridge" })).toBe(true);
    expect(evaluateCondition(condition, { provider: "Bridge" })).toBe(true);
    expect(evaluateCondition(condition, { provider: "stripe" })).toBe(false);
    expect(evaluateCondition(guard("attempt", "in", ["1", "2"]), { attempt: 2 })).toBe(true);
  });

  it("requires every clause to hold", () => {
    const condition: WorkflowCondition = {
      all: [
        { field: "provider", op: "eq", value: "mural" },
        { field: "counterpartyKind", op: "eq", value: "business" },
      ],
    } as WorkflowCondition;
    expect(evaluateCondition(condition, { provider: "mural", counterpartyKind: "business" })).toBe(
      true
    );
    expect(
      evaluateCondition(condition, { provider: "mural", counterpartyKind: "individual" })
    ).toBe(false);
  });
});
