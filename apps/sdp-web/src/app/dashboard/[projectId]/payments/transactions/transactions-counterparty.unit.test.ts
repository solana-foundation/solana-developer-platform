import { describe, expect, it } from "vitest";
import { resolveTransactionCounterpartyReference } from "../payments-overview.utils";

describe("resolveTransactionCounterpartyReference", () => {
  it("prefers a non-blank counterparty ID", () => {
    expect(
      resolveTransactionCounterpartyReference({
        counterpartyId: " cpty_1234567890 ",
        destination: "vendor-wallet",
      })
    ).toBe("cpty_1234567890");
  });

  it("uses the source for inbound and onramp transfers", () => {
    expect(
      resolveTransactionCounterpartyReference({
        direction: "inbound",
        source: "sender-wallet",
        destination: "our-wallet",
      })
    ).toBe("sender-wallet");
    expect(
      resolveTransactionCounterpartyReference({
        type: "onramp",
        source: "ramp-provider-reference",
        destination: "our-wallet",
      })
    ).toBe("ramp-provider-reference");
  });

  it("uses the destination for outbound and offramp transfers", () => {
    expect(
      resolveTransactionCounterpartyReference({
        direction: "outbound",
        source: "our-wallet",
        destination: "vendor-wallet",
      })
    ).toBe("vendor-wallet");
    expect(
      resolveTransactionCounterpartyReference({
        type: "offramp",
        source: "our-wallet",
        destination: "payout-provider",
      })
    ).toBe("payout-provider");
  });

  it("falls back across missing fields and ignores blank references", () => {
    expect(
      resolveTransactionCounterpartyReference({ direction: "inbound", destination: "our-wallet" })
    ).toBe("our-wallet");
    expect(
      resolveTransactionCounterpartyReference({
        direction: "outbound",
        source: "our-wallet",
        destination: "   ",
      })
    ).toBe("our-wallet");
    expect(resolveTransactionCounterpartyReference({ counterpartyId: "   " })).toBeUndefined();
  });
});
