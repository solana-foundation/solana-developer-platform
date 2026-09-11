import { HeliusRingsError } from "@sdp/helius-rings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRingsMergingEnabled } from "./merging.js";

const { buildSetMergingEnabledTransaction, fetchUserRecord, landTransaction } = vi.hoisted(() => ({
  buildSetMergingEnabledTransaction: vi.fn(),
  fetchUserRecord: vi.fn(),
  landTransaction: vi.fn(),
}));

vi.mock("@heliuslabs/zolana/wallet", () => ({
  buildSetMergingEnabledTransaction,
  fetchUserRecord,
}));

// Stubbed because the custody sign-and-broadcast round trip is covered where it
// lives; here the question is only whether it is reached, and with what.
vi.mock("./provision.js", () => ({ landTransaction }));

const OWNER = "5hQVjMN4AENMgCWQsNfzRhC1YrvmgnaFyKYefmY2oY7z";
const TRANSACTION = { transaction: true };

function record(mergingEnabled: boolean) {
  return { owner: OWNER, mergingEnabled, bump: 255 };
}

const DEPS = { client: {}, signTransaction: vi.fn(), submitTransaction: vi.fn() } as never;

describe("ensureRingsMergingEnabled", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    buildSetMergingEnabledTransaction.mockResolvedValue(TRANSACTION);
    landTransaction.mockResolvedValue("sig_enable");
  });

  it("sends nothing when the record already permits merging", async () => {
    fetchUserRecord.mockResolvedValue(record(true));

    const result = await ensureRingsMergingEnabled(DEPS, { owner: OWNER });

    // The common case, since provisioning enables it: paying for a transaction
    // on every merge would be a fee for nothing.
    expect(result).toEqual({ signature: null });
    expect(buildSetMergingEnabledTransaction).not.toHaveBeenCalled();
    expect(landTransaction).not.toHaveBeenCalled();
  });

  it("enables merging for a record registered before merge shipped", async () => {
    fetchUserRecord.mockResolvedValueOnce(record(false)).mockResolvedValueOnce(record(true));

    const result = await ensureRingsMergingEnabled(DEPS, { owner: OWNER });

    expect(result).toEqual({ signature: "sig_enable" });
    expect(buildSetMergingEnabledTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, enabled: true })
    );
    // Custody signs for this owner specifically; a gateway serves the whole
    // tenant, so an unnamed owner would sign the wrong wallet's transaction.
    expect(landTransaction).toHaveBeenCalledWith(DEPS, TRANSACTION, OWNER);
  });

  it("refuses an owner with no record rather than enabling nothing", async () => {
    fetchUserRecord.mockResolvedValue(undefined);

    await expect(ensureRingsMergingEnabled(DEPS, { owner: OWNER })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("provision the wallet"),
    });
    expect(landTransaction).not.toHaveBeenCalled();
  });

  it("refuses a confirmed enable that the record does not reflect", async () => {
    // Landing is not the same as taking effect. Reporting success here would
    // send the merge straight into the refusal this call exists to clear.
    fetchUserRecord.mockResolvedValueOnce(record(false)).mockResolvedValueOnce(record(false));

    await expect(ensureRingsMergingEnabled(DEPS, { owner: OWNER })).rejects.toBeInstanceOf(
      HeliusRingsError
    );
  });

  it("reads the record again after enabling rather than trusting the send", async () => {
    fetchUserRecord.mockResolvedValueOnce(record(false)).mockResolvedValueOnce(record(true));

    await ensureRingsMergingEnabled(DEPS, { owner: OWNER });

    expect(fetchUserRecord).toHaveBeenCalledTimes(2);
  });
});
