import { describe, expect, it } from "vitest";
import { shouldSetCustodyScopeDefault } from "./custody-provider-lifecycle.service";

describe("custody provider lifecycle service", () => {
  it("only promotes signing-capable providers to the implicit scope default", () => {
    expect(
      shouldSetCustodyScopeDefault({
        candidateProvider: "anchorage",
        currentDefaultProvider: null,
      })
    ).toBe(false);
    expect(
      shouldSetCustodyScopeDefault({
        candidateProvider: "privy",
        currentDefaultProvider: null,
      })
    ).toBe(true);
    expect(
      shouldSetCustodyScopeDefault({
        candidateProvider: "privy",
        currentDefaultProvider: "anchorage",
      })
    ).toBe(true);
    expect(
      shouldSetCustodyScopeDefault({
        candidateProvider: "para",
        currentDefaultProvider: "privy",
      })
    ).toBe(false);
  });
});
