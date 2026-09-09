/**
 * What crosses to a party, and what must not.
 *
 * The policy in 0089 lets a named party read the whole row. Everything on that
 * row which belongs to the creating organization rather than to the chain is
 * withheld here and nowhere else, so this file is the enforcement.
 *
 * Asserted against the serialized JSON rather than field by field, because the
 * failure mode is a field ARRIVING — someone reaching for `toTradeResponse` for
 * convenience, or adding a column to the row and the response together. A test
 * that lists the fields it expects would pass straight through that.
 */

import { describe, expect, it } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import type { DvpInboundTrade } from "@/services/dvp/inbound";
import { toDvpInboundResponse } from "./inbound-response";

const SECRET_REF = "internal-desk-ref-4417";
const SECRET_ORG = "org_the_agent_desk";
const SECRET_PROJECT = "prj_the_agent_desk";
const SECRET_WALLET = "cwlt_the_agent_desk";
const SECRET_IDEMPOTENCY = "idem_the_agent_desk";

function inbound(): DvpInboundTrade {
  const trade = {
    id: "dvp_inbound_1",
    organizationId: SECRET_ORG,
    projectId: SECRET_PROJECT,
    status: "created",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    userA: "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC",
    userB: "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    tokenProgramA: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    tokenProgramB: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimalsA: 6,
    decimalsB: 6,
    symbolA: "ATD",
    symbolB: "DUSD",
    amountA: "100000000",
    amountB: "250000000",
    escrowA: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    escrowB: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
    escrowAAmount: "100000000",
    escrowBAmount: null,
    escrowAFrozen: false,
    escrowBFrozen: false,
    userASettlementDestination: "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC",
    userBSettlementDestination: "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk",
    nonce: "42",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    refString: SECRET_REF,
    sdpSide: null,
    tradeKind: "agent",
    sdpWalletId: SECRET_WALLET,
    idempotencyKey: SECRET_IDEMPOTENCY,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    observedAt: "2026-09-07T00:00:10.000Z",
  } as unknown as DvpTradeRow;

  return { trade, side: "b", party: trade.userB };
}

describe("toDvpInboundResponse", () => {
  it("tells the party which leg is theirs and which address matched", () => {
    const response = toDvpInboundResponse(inbound());

    expect(response.yourSide).toBe("b");
    expect(response.yourParty).toBe("C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk");
  });

  // The escrow address is the entire integration for a party: without it there
  // is nothing they can act on and discovery is pointless.
  it("gives them the escrow to pay and the amount owed", () => {
    const response = toDvpInboundResponse(inbound());

    expect(response.legs.b.escrow).toBe("6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y");
    expect(response.legs.b.amount).toBe("250000000");
    expect(response.legs.b.decimals).toBe(6);
  });

  // Everything above is on chain already. A party holding the PDA can decode
  // all of it, so withholding it would protect nothing and break the feature.
  it("passes through the terms, which are public on chain anyway", () => {
    const response = toDvpInboundResponse(inbound());

    expect(response.swapDvp).toBe("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");
    expect(response.legs.a.mint).toBe("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1");
    expect(response.expiryTimestamp).toBe("1900000000");
  });

  /**
   * The one that matters. Searching the serialized JSON catches a field that
   * arrives later under any name, which is the actual risk: nobody will delete
   * `refString` on purpose, someone will reintroduce it by reusing the other
   * serializer.
   */
  it.each([
    ["the creating organization", SECRET_ORG],
    ["the creating project", SECRET_PROJECT],
    ["the creating org's own reference", SECRET_REF],
    ["the creating org's custody wallet", SECRET_WALLET],
    ["the idempotency key", SECRET_IDEMPOTENCY],
  ])("does not disclose %s", (_label, secret) => {
    const json = JSON.stringify(toDvpInboundResponse(inbound()));

    expect(json).not.toContain(secret);
  });

  // Whether their settlement authority holds enough SOL is an operational fact
  // about somebody else's deployment, and it is not on chain in this trade.
  it("says nothing about the other organization's settlement readiness", () => {
    const response = toDvpInboundResponse(inbound()) as unknown as Record<string, unknown>;

    expect(response.settlementReadiness).toBeUndefined();
    expect(response.sdpWallet).toBeUndefined();
    expect(response.refString).toBeUndefined();
  });
});
