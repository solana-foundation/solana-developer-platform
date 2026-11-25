import { describe, expect, it } from "vitest";
import { parTermsFromRecordedRequest } from "./vault-queued-withdraw.service";

describe("recorded par redemption source", () => {
  it("recovers burned shares without redeeming the quoted intermediate again", () => {
    expect(parTermsFromRecordedRequest({ shares: "1600", intermediate_amount: "2000" })).toEqual({
      mechanism: "operator_redemption",
      shares: "1600",
    });
  });

  it("recovers held intermediate when the request burned no shares", () => {
    expect(parTermsFromRecordedRequest({ shares: "0", intermediate_amount: "2000" })).toEqual({
      mechanism: "operator_redemption",
      intermediateAmount: "2000",
    });
  });
});
