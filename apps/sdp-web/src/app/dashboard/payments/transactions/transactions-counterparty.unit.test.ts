import { describe, expect, it } from "vitest";
import {
  getTransactionCounterpartyPresentation,
  resolveTransactionCounterpartyReference,
  retainTransactionCounterpartyDisplayName,
} from "./transactions-counterparty";

describe("transaction counterparty presentation", () => {
  it("prefers a human display name and keeps the counterparty ID as secondary context", () => {
    expect(
      getTransactionCounterpartyPresentation({
        counterpartyDisplayName: "Acme Studio",
        counterpartyId: "counterparty_1234567890",
        destination: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
      })
    ).toEqual({
      displayName: "Acme Studio",
      primary: "Acme Studio",
      reference: "counterparty_1234567890",
      secondary: "counte…7890",
    });
  });

  it("keeps a destination address as secondary context when no counterparty ID is present", () => {
    expect(
      getTransactionCounterpartyPresentation({
        counterpartyDisplayName: "Northstar Labs",
        destination: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
      })
    ).toEqual({
      displayName: "Northstar Labs",
      primary: "Northstar Labs",
      reference: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
      secondary: "8dHEsG…WRGZ",
    });
  });

  it("falls back to the shortened reference when the API has no display name", () => {
    expect(
      getTransactionCounterpartyPresentation({
        counterpartyId: "counterparty_1234567890",
      })
    ).toEqual({
      primary: "counte…7890",
      reference: "counterparty_1234567890",
    });
  });

  it("uses the source as the fallback counterparty for inbound transfers", () => {
    expect(
      getTransactionCounterpartyPresentation({
        direction: "inbound",
        source: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
        destination: "OurTreasuryWallet1111111111111111111111111111",
      })
    ).toEqual({
      primary: "8dHEsG…WRGZ",
      reference: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
    });
  });

  it("uses the source as the fallback for an onramp without a direction", () => {
    expect(
      resolveTransactionCounterpartyReference({
        type: "onramp",
        source: "ramp-provider-reference",
        destination: "our-wallet",
      })
    ).toBe("ramp-provider-reference");
  });

  it("keeps the destination fallback for outbound and offramp transfers", () => {
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

  it("ignores blank display names and returns an empty-state label without a reference", () => {
    expect(
      getTransactionCounterpartyPresentation({
        counterpartyDisplayName: "   ",
      })
    ).toEqual({ primary: "—" });
  });

  it("retains the list display name when the detail response only contains the counterparty ID", () => {
    expect(
      retainTransactionCounterpartyDisplayName(
        {
          id: "transfer_1",
          status: "confirmed",
          signature: null,
          counterpartyId: "counterparty_1",
        },
        {
          counterpartyDisplayName: "Acme Studio",
          counterpartyId: "counterparty_1",
        }
      )
    ).toMatchObject({
      counterpartyId: "counterparty_1",
      counterpartyDisplayName: "Acme Studio",
    });
  });

  it("prefers a display name returned by the detail endpoint over the list summary", () => {
    expect(
      retainTransactionCounterpartyDisplayName(
        {
          id: "transfer_1",
          status: "confirmed",
          signature: null,
          counterpartyDisplayName: "Updated Acme Studio",
        },
        { counterpartyDisplayName: "Acme Studio" }
      ).counterpartyDisplayName
    ).toBe("Updated Acme Studio");
  });
});
