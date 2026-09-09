/**
 * Refusing a settlement destination that cannot own a token account.
 *
 * These assert on account OWNERSHIP alone, which is the whole of the rule. An
 * earlier version of this check tried to name whether the address was a mint or
 * a token account by measuring the account, and every one of those assertions
 * would have passed while the check itself was wrong — a Token-2022 mint with
 * extensions is 368 bytes, not 82, so it slipped the mint branch. There is no
 * byte fixture here because there is no longer any byte-level claim to make.
 */

import { describe, expect, it, vi } from "vitest";

const getAccountInfo = vi.hoisted(() => vi.fn());
vi.mock("@sdp/rpc/solana", () => ({ getAccountInfo }));

const { findDvpDestinationProblem } = await import("./inspect-destination");

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const LEGACY_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** Stake program, standing in for any other program that may own a PDA. */
const OTHER_PROGRAM = "Stake11111111111111111111111111111111111111";

const DESTINATION = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg" as never;
const rpc = {} as never;

describe("findDvpDestinationProblem", () => {
  // The case the whole check exists for. Both programs own mints AND token
  // accounts, and neither can hold an ATA, so ownership settles it without
  // having to work out which one this is.
  it.each([
    ["Token-2022", TOKEN_2022],
    ["legacy SPL Token", LEGACY_TOKEN],
  ])("refuses an address owned by the %s program", async (_label, owner) => {
    getAccountInfo.mockResolvedValue({ owner, data: ["", "base64"] });

    await expect(findDvpDestinationProblem(rpc, DESTINATION)).resolves.toBe("token-program-owned");
  });

  it("allows an ordinary system-owned wallet", async () => {
    getAccountInfo.mockResolvedValue({ owner: SYSTEM_PROGRAM, data: ["", "base64"] });

    await expect(findDvpDestinationProblem(rpc, DESTINATION)).resolves.toBeNull();
  });

  // Deliberate: a vault PDA delivering to its own authority is a real trade
  // shape, and the associated-token program permits an off-curve owner.
  it("allows an account owned by some other program", async () => {
    getAccountInfo.mockResolvedValue({ owner: OTHER_PROGRAM, data: ["", "base64"] });

    await expect(findDvpDestinationProblem(rpc, DESTINATION)).resolves.toBeNull();
  });

  // ATA derivation seeds on the owner's bytes and never reads the owner's
  // account, so an address nobody has funded is a perfectly good destination.
  // Refusing it would mean you cannot pay a counterparty until they have
  // already transacted.
  it("allows an address with no account at all", async () => {
    getAccountInfo.mockResolvedValue(null);

    await expect(findDvpDestinationProblem(rpc, DESTINATION)).resolves.toBeNull();
  });
});
