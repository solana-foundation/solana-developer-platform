import { describe, expect, it } from "vitest";
import { prepareRingsOperationSchema } from "./schemas";

/**
 * Per-flow strictness, because the fields are not interchangeable and the
 * database has opinions the caller should hear as a 400 rather than a 500.
 */

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RECIPIENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const WALLET_ID = "hrw_1";
const CLIENT_NONCE = "nonce-1";

function parse(body: Record<string, unknown>) {
  return prepareRingsOperationSchema.safeParse({
    walletId: WALLET_ID,
    clientNonce: CLIENT_NONCE,
    ...body,
  });
}

describe("prepareRingsOperationSchema", () => {
  it("accepts the four supported flows", () => {
    expect(parse({ opType: "shield", asset: { mint: SOL, amountRaw: "1000" } }).success).toBe(true);
    expect(parse({ opType: "merge", asset: { mint: USDC } }).success).toBe(true);
    expect(
      parse({ opType: "withdraw", asset: { mint: SOL, amountRaw: "1000" }, to: RECIPIENT }).success
    ).toBe(true);
    expect(
      parse({
        opType: "transfer_registered",
        asset: { mint: USDC, amountRaw: "1000" },
        to: RECIPIENT,
      }).success
    ).toBe(true);
  });

  it.each([
    [
      "shield",
      { opType: "shield", asset: { mint: SOL, amountRaw: "1000" } },
      {
        walletId: WALLET_ID,
        opType: "shield",
        asset: { mint: SOL, amountRaw: "1000" },
        clientNonce: CLIENT_NONCE,
      },
    ],
    [
      "transfer_registered",
      {
        opType: "transfer_registered",
        asset: { mint: USDC, amountRaw: "1000" },
        to: RECIPIENT,
      },
      {
        walletId: WALLET_ID,
        opType: "transfer_registered",
        asset: { mint: USDC, amountRaw: "1000" },
        to: RECIPIENT,
        clientNonce: CLIENT_NONCE,
        transferMode: "registered",
      },
    ],
    [
      "withdraw",
      { opType: "withdraw", asset: { mint: SOL, amountRaw: "1000" }, to: RECIPIENT },
      {
        walletId: WALLET_ID,
        opType: "withdraw",
        asset: { mint: SOL, amountRaw: "1000" },
        to: RECIPIENT,
        clientNonce: CLIENT_NONCE,
      },
    ],
    [
      "merge",
      { opType: "merge", asset: { mint: USDC } },
      {
        walletId: WALLET_ID,
        opType: "merge",
        asset: { mint: USDC },
        clientNonce: CLIENT_NONCE,
      },
    ],
  ])("returns the exact %s operation payload", (_opType, body, expected) => {
    const result = parse(body);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(expected);
  });

  it.each([
    [
      "shield",
      { opType: "shield", asset: { mint: SOL, amountRaw: "1" } },
      ["from", "to", "zoneId", "transferMode", "timelock", "unexpected"],
    ],
    [
      "transfer_registered",
      {
        opType: "transfer_registered",
        asset: { mint: USDC, amountRaw: "1" },
        to: RECIPIENT,
      },
      ["from", "zoneId", "timelock", "unexpected"],
    ],
    [
      "withdraw",
      { opType: "withdraw", asset: { mint: SOL, amountRaw: "1" }, to: RECIPIENT },
      ["from", "zoneId", "transferMode", "timelock", "unexpected"],
    ],
    [
      "merge",
      { opType: "merge", asset: { mint: USDC } },
      ["from", "to", "zoneId", "transferMode", "timelock", "unexpected"],
    ],
  ])("rejects fields outside the exact %s shape", (_opType, body, fields) => {
    const values: Record<string, unknown> = {
      from: RECIPIENT,
      to: RECIPIENT,
      zoneId: "zone_1",
      transferMode: "registered",
      timelock: { unlockAt: "2026-08-25T12:00:00.000Z", beneficiary: RECIPIENT },
      unexpected: true,
    };

    for (const field of fields) {
      expect(parse({ ...body, [field]: values[field] }).success, field).toBe(false);
    }
  });

  it.each([
    ["shield", { opType: "shield", asset: { mint: SOL, amountRaw: "1", ticker: "SOL" } }],
    [
      "transfer_registered",
      {
        opType: "transfer_registered",
        asset: { mint: USDC, amountRaw: "1", ticker: "USDC" },
        to: RECIPIENT,
      },
    ],
    [
      "withdraw",
      {
        opType: "withdraw",
        asset: { mint: SOL, amountRaw: "1", ticker: "SOL" },
        to: RECIPIENT,
      },
    ],
    ["merge", { opType: "merge", asset: { mint: USDC, ticker: "USDC" } }],
  ])("rejects unknown keys inside the %s asset", (_opType, body) => {
    expect(parse(body).success).toBe(false);
  });

  it("refuses an amount on a merge", () => {
    // A merge consolidates every note of the mint. An amount would sit on the
    // row and be read as real by policy and the activity feed while the builder
    // ignores it entirely.
    const result = parse({ opType: "merge", asset: { mint: USDC, amountRaw: "1000" } });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("takes no amount");
  });

  it("refuses an SPL withdrawal at the edge", () => {
    // The pool's token-interface address is derived inside the SDK and not
    // exported, so this cannot be assembled at all. Failing here spares the
    // caller a policy evaluation and possibly a human approval.
    const result = parse({
      opType: "withdraw",
      asset: { mint: USDC, amountRaw: "1000" },
      to: RECIPIENT,
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("only SOL withdrawals");
  });

  it("normalises the transfer mode rather than demanding it", () => {
    // The database requires exactly `registered` for this op type, and a caller
    // who named the flow has already said which mode they meant.
    const result = parse({
      opType: "transfer_registered",
      asset: { mint: USDC, amountRaw: "1000" },
      to: RECIPIENT,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(result.data).toMatchObject({
      opType: "transfer_registered",
      transferMode: "registered",
    });
  });

  it.each([
    [
      "withdraw",
      { asset: { mint: SOL, amountRaw: "1" }, to: RECIPIENT, transferMode: "registered" },
    ],
    ["shield", { asset: { mint: SOL, amountRaw: "1" }, transferMode: "registered" }],
    ["merge", { asset: { mint: SOL }, transferMode: "registered" }],
  ])("refuses a transfer mode on a %s", (opType, body) => {
    // The same constraint from the other side: a mode on these op types is a
    // violation, not a hint.
    expect(parse({ opType, ...body }).success).toBe(false);
  });

  it("refuses an anonymous transfer", () => {
    const result = parse({
      opType: "transfer_registered",
      asset: { mint: USDC, amountRaw: "1000" },
      to: RECIPIENT,
      transferMode: "anonymous",
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("not supported");
  });

  it("refuses an absent asset rather than defaulting to SOL", () => {
    // Defaulting would move a token the caller never named.
    expect(parse({ opType: "shield" }).success).toBe(false);
    expect(parse({ opType: "merge" }).success).toBe(false);
  });

  it.each(["transfer_anonymous", "split", "zone_create", "timelock_create"])(
    "refuses the unsupported op type %s",
    (opType) => {
      expect(parse({ opType, asset: { mint: SOL, amountRaw: "1" } }).success).toBe(false);
    }
  );
});
