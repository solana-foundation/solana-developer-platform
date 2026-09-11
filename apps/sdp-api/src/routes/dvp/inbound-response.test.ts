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
import type { DvpCallerWallet, DvpInboundTrade } from "@/services/dvp/inbound";
import { toDvpInboundResponse } from "./inbound-response";

const SECRET_REF = "internal-desk-ref-4417";
const SECRET_ORG = "org_the_agent_desk";
const SECRET_PROJECT = "prj_the_agent_desk";
const SECRET_WALLET = "cwlt_the_agent_desk";
const SECRET_IDEMPOTENCY = "idem_the_agent_desk";

const USER_A = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
const USER_B = "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk";

/** The caller's custody map: it holds side B's address, matching `side: "b"`. */
const CALLER_ADDRESSES = new Map<string, DvpCallerWallet>([
  [USER_B, { id: "cwlt_the_viewer", name: "Viewer Desk" }],
  ["9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY", { id: "cwlt_another_of_theirs", name: null }],
]);

/** No mint is issued by the viewer's organization, so every image resolves null. */
const NO_MINT_IMAGES = new Map<string, string | null>();

function inbound(): DvpInboundTrade {
  const trade = {
    id: "dvp_inbound_1",
    organizationId: SECRET_ORG,
    projectId: SECRET_PROJECT,
    status: "created",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    userA: USER_A,
    userB: USER_B,
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    tokenProgramA: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    tokenProgramB: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimalsA: 6,
    decimalsB: 6,
    symbolA: "ATD",
    symbolB: "DUSD",
    nameA: "Acme Treasury Debt",
    nameB: "Digital USD",
    amountA: "100000000",
    amountB: "250000000",
    escrowA: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    escrowB: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
    escrowAAmount: "100000000",
    escrowBAmount: null,
    escrowAPeakAmount: "100000000",
    escrowBPeakAmount: "0",
    escrowAFrozen: false,
    escrowBFrozen: false,
    userASettlementDestination: USER_A,
    userBSettlementDestination: USER_B,
    nonce: "42",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    refString: SECRET_REF,
    counterpartyAccountIdA: null,
    counterpartyAccountIdB: null,
    idempotencyKey: SECRET_IDEMPOTENCY,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    observedAt: "2026-09-07T00:00:10.000Z",
  } as unknown as DvpTradeRow;

  return { trade, side: "b", party: trade.userB };
}

describe("toDvpInboundResponse", () => {
  it("tells the party which leg is theirs and which address matched", () => {
    const response = toDvpInboundResponse(inbound(), CALLER_ADDRESSES, NO_MINT_IMAGES);

    expect(response.yourSide).toBe("b");
    expect(response.yourParty).toBe(USER_B);
  });

  // The escrow address is the entire integration for a party: without it there
  // is nothing they can act on and discovery is pointless.
  it("gives them the escrow to pay and the amount owed", () => {
    const response = toDvpInboundResponse(inbound(), CALLER_ADDRESSES, NO_MINT_IMAGES);

    expect(response.legs.b.escrow).toBe("6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y");
    expect(response.legs.b.amount).toBe("250000000");
    expect(response.legs.b.decimals).toBe(6);
  });

  it("returns the full leg shape with its server-derived outcome", () => {
    const response = toDvpInboundResponse(inbound(), CALLER_ADDRESSES, NO_MINT_IMAGES);

    expect(response.legs.b).toEqual({
      party: {
        address: USER_B,
        counterparty: null,
        wallet: { id: "cwlt_the_viewer", name: "Viewer Desk" },
      },
      mint: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      amount: "250000000",
      decimals: 6,
      symbol: "DUSD",
      name: "Digital USD",
      imageUrl: null,
      escrow: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
      settlementDestination: USER_B,
      observedAmount: null,
      frozen: false,
      outcome: "awaiting",
    });
  });

  // The image is the CALLER's organization's fact, resolved against its own
  // issued tokens: a mint the viewer's organization issued resolves its URL,
  // an unissued one reads null — never the creating org's artwork.
  it("carries the image only for a mint the caller's own organization issued", () => {
    const mintImages = new Map<string, string | null>([
      ["AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE", "https://cdn.example.test/dusd.png"],
      ["ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1", null],
    ]);
    const response = toDvpInboundResponse(inbound(), CALLER_ADDRESSES, mintImages);

    expect(response.legs.b.imageUrl).toBe("https://cdn.example.test/dusd.png");
    expect(response.legs.a.imageUrl).toBeNull();
  });

  it("reads an absent mint as null instead of inventing an image", () => {
    const response = toDvpInboundResponse(inbound(), CALLER_ADDRESSES, NO_MINT_IMAGES);

    expect(response.legs.a.imageUrl).toBeNull();
    expect(response.legs.b.imageUrl).toBeNull();
  });

  // Everything above is on chain already. A party holding the PDA can decode
  // all of it, so withholding it would protect nothing and break the feature.
  it("passes through the terms, which are public on chain anyway", () => {
    const response = toDvpInboundResponse(inbound(), CALLER_ADDRESSES, NO_MINT_IMAGES);

    expect(response.swapDvp).toBe("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");
    expect(response.legs.a.mint).toBe("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1");
    expect(response.expiryTimestamp).toBe("1900000000");
  });

  // The same party-object shape the creator's view uses — except attribution:
  // which registered counterparty a party is belongs to the creating
  // organization and never crosses to a party viewer, so it is null even
  // though the property is present. `wallet` carries the CALLER's own custody
  // wallet identity for their side, null for the other.
  it("answers each leg's party as a derived object, wallet from the caller's own wallets", () => {
    const response = toDvpInboundResponse(inbound(), CALLER_ADDRESSES, NO_MINT_IMAGES);

    expect(response.legs.a.party).toEqual({
      address: USER_A,
      counterparty: null,
      wallet: null,
    });
    expect(response.legs.b.party).toEqual({
      address: USER_B,
      counterparty: null,
      wallet: { id: "cwlt_the_viewer", name: "Viewer Desk" },
    });
  });

  // A wallet with no display name is still enriched — the id is the identity,
  // and the name falling back to null is the caller's own fact, not a failure
  // to resolve the wallet.
  it("answers a wallet with a null name as null-named, not as unheld", () => {
    const response = toDvpInboundResponse(
      inbound(),
      new Map<string, DvpCallerWallet>([[USER_B, { id: "cwlt_unnamed", name: null }]]),
      NO_MINT_IMAGES
    );

    expect(response.legs.b.party.wallet).toEqual({ id: "cwlt_unnamed", name: null });
    expect(response.yourSide).toBe("b");
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
    const json = JSON.stringify(toDvpInboundResponse(inbound(), CALLER_ADDRESSES, NO_MINT_IMAGES));

    expect(json).not.toContain(secret);
  });
});
