/**
 * Shared fixtures for the DvP unit tests.
 *
 * One `leg`/`trade` factory pair so every surface is tested against the same
 * wire shape — the list, the detail page, the next-step panel, the close
 * actions and the derivations all build from the pinned response.
 */

import type { DvpPartyRef, DvpTrade, DvpTradeLeg, DvpTradeStatus } from "./dvp-trade";

export const LEG_ESCROW_A = "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU";
export const LEG_ESCROW_B = "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y";
export const OWN_ADDRESS = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
export const OTHER_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
export const THIRD_ADDRESS = "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk";

/** The caller's custody wallet id behind `OWN_ADDRESS` in these fixtures. */
export const OWN_WALLET_ID = "cwlt_dvp_fixture_own";

/** The caller's custody wallet behind `OWN_ADDRESS`, as the API would resolve it. */
export function ownParty(overrides: Partial<DvpPartyRef> = {}): DvpPartyRef {
  return {
    address: OWN_ADDRESS,
    counterparty: null,
    wallet: { id: OWN_WALLET_ID, name: "Fixture Desk" },
    ...overrides,
  };
}

export function testParty(overrides: Partial<DvpPartyRef> = {}): DvpPartyRef {
  return {
    address: OTHER_ADDRESS,
    counterparty: null,
    wallet: null,
    ...overrides,
  };
}

export function testLeg(overrides: Partial<DvpTradeLeg> = {}): DvpTradeLeg {
  return {
    party: testParty(),
    mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 6,
    symbol: "ATD",
    name: "Acme Treasury Debt",
    imageUrl: null,
    amount: "1000000000",
    escrow: LEG_ESCROW_A,
    settlementDestination: OTHER_ADDRESS,
    funding: null,
    fundingSignature: null,
    outcome: "awaiting",
    ...overrides,
  };
}

export function testTrade(overrides: Partial<DvpTrade> = {}): DvpTrade {
  return {
    id: "dvp_1",
    status: "created" as DvpTradeStatus,
    kind: "principal",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    legs: { a: testLeg({ escrow: LEG_ESCROW_A }), b: testLeg({ escrow: LEG_ESCROW_B }) },
    nonce: "42",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    refString: null,
    createSignature: null,
    closeSignature: null,
    observedAt: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}
