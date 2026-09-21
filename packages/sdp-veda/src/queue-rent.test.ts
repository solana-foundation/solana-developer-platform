import { type Address, address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  queuedWithdrawalOwnerFundedAccountSizes,
  queuedWithdrawalRequestAddress,
  VEDA_REQUEST_WITHDRAW_DISCRIMINATOR,
  VEDA_SETUP_USER_WITHDRAW_STATE_DISCRIMINATOR,
  VEDA_USER_WITHDRAW_STATE_ACCOUNT_SIZE,
  VEDA_WITHDRAW_REQUEST_ACCOUNT_SIZE,
} from "./queue-rent";

const QUEUE = address("Cchro8d7bN5Xfk77z9hJKxREJwSAjpz5K2seK4iNN396");
const OWNER = address("11111111111111111111111111111112");
const OTHER_OWNER = address("SysvarC1ock11111111111111111111111111111111");
const REQUEST = address("Vote111111111111111111111111111111111111111");

function instruction(
  discriminator: readonly number[],
  accounts: readonly { address: Address; role: number }[],
  programAddress: Address = QUEUE
): Instruction {
  return {
    programAddress,
    accounts,
    data: new Uint8Array([...discriminator, 99]),
  } as Instruction;
}

function request(
  owner: Address = OWNER,
  requestAddress: Address = REQUEST,
  ownerRole = 3,
  requestRole = 1
): Instruction {
  const accounts: { address: Address; role: number }[] = Array.from({ length: 6 }, () => ({
    address: OWNER,
    role: 0,
  }));
  accounts[0] = { address: owner, role: ownerRole };
  accounts[5] = { address: requestAddress, role: requestRole };
  return instruction(VEDA_REQUEST_WITHDRAW_DISCRIMINATOR, accounts);
}

describe("queuedWithdrawalRequestAddress", () => {
  it("reads the owner-bound PDA from the committed request account index", () => {
    expect(queuedWithdrawalRequestAddress([request()], QUEUE, OWNER)).toBe(REQUEST);
  });

  it("rejects wrong-program and wrong-owner instructions", () => {
    expect(
      queuedWithdrawalRequestAddress(
        [request()],
        address("11111111111111111111111111111111"),
        OWNER
      )
    ).toBeUndefined();
    expect(queuedWithdrawalRequestAddress([request(OTHER_OWNER)], QUEUE, OWNER)).toBeUndefined();
  });

  it("rejects truncated and ambiguous plans", () => {
    const truncated = instruction(VEDA_REQUEST_WITHDRAW_DISCRIMINATOR, [
      { address: OWNER, role: 3 },
    ]);
    expect(queuedWithdrawalRequestAddress([truncated], QUEUE, OWNER)).toBeUndefined();
    expect(queuedWithdrawalRequestAddress([request(), request()], QUEUE, OWNER)).toBeUndefined();
  });

  it("rejects account-table lookalikes without the committed signer and writable roles", () => {
    const wrongSignerRole = request(OWNER, REQUEST, 1, 1);
    const wrongRequestRole = request(OWNER, REQUEST, 3, 0);
    expect(queuedWithdrawalRequestAddress([wrongSignerRole], QUEUE, OWNER)).toBeUndefined();
    expect(queuedWithdrawalRequestAddress([wrongRequestRole], QUEUE, OWNER)).toBeUndefined();
  });
});

describe("queuedWithdrawalOwnerFundedAccountSizes", () => {
  it("charges every request for its request account", () => {
    expect(queuedWithdrawalOwnerFundedAccountSizes([request()], QUEUE, OWNER)).toEqual([
      VEDA_WITHDRAW_REQUEST_ACCOUNT_SIZE,
    ]);
  });

  it("also charges the one-time user state when setup is in this exact plan", () => {
    const setup = instruction(VEDA_SETUP_USER_WITHDRAW_STATE_DISCRIMINATOR, [
      { address: OWNER, role: 3 },
    ]);
    expect(queuedWithdrawalOwnerFundedAccountSizes([setup, request()], QUEUE, OWNER)).toEqual([
      VEDA_USER_WITHDRAW_STATE_ACCOUNT_SIZE,
      VEDA_WITHDRAW_REQUEST_ACCOUNT_SIZE,
    ]);
  });

  it("does not infer rent from lookalike or owner-mismatched instructions", () => {
    const otherSetup = instruction(VEDA_SETUP_USER_WITHDRAW_STATE_DISCRIMINATOR, [
      { address: OTHER_OWNER, role: 3 },
    ]);
    expect(queuedWithdrawalOwnerFundedAccountSizes([otherSetup, request()], QUEUE, OWNER)).toEqual([
      VEDA_WITHDRAW_REQUEST_ACCOUNT_SIZE,
    ]);
    expect(queuedWithdrawalOwnerFundedAccountSizes([], QUEUE, OWNER)).toEqual([]);
  });
});
