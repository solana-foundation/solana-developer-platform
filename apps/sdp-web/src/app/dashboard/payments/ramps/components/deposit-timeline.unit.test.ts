import { describe, expect, it } from "vitest";
import { depositStageStates } from "./deposit-timeline-stages";

describe("depositStageStates", () => {
  it("puts sending on the payer while the provider waits", () => {
    expect(depositStageStates("awaiting_payment")).toEqual(["done", "current", "upcoming"]);
    expect(depositStageStates(undefined)).toEqual(["done", "current", "upcoming"]);
  });

  it("marks the provider's receipt once it settles, and everything once complete", () => {
    expect(depositStageStates("settling")).toEqual(["done", "done", "current"]);
    expect(depositStageStates("completed")).toEqual(["done", "done", "done"]);
  });
});
