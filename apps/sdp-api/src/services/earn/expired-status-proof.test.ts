import { getBase58Decoder, type Signature, signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  installClusterRpcResponder,
  type StubSignatureStatus,
  signatureStatusesReplyAt,
} from "@/test/helpers/cluster-rpc";
import { earnClusterRpc } from "./cluster-rpc";
import { reReadExpiredStatuses } from "./expired-status-proof";

/** A well-formed signature whose 64 bytes are all `fill`. */
function signatureOf(fill: number): Signature {
  return signature(getBase58Decoder().decode(new Uint8Array(64).fill(fill)));
}

const LANDED = signatureOf(1);
const ABSENT = signatureOf(2);
const UNKNOWN = signatureOf(3);

const FINALIZED: StubSignatureStatus = {
  slot: 7,
  confirmations: null,
  confirmationStatus: "finalized",
  err: null,
};

describe("reReadExpiredStatuses", () => {
  const rpc = installClusterRpcResponder();

  function statusReads() {
    return rpc.requests.filter(({ method }) => method === "getSignatureStatuses");
  }

  it("asks no node anything when no row expired unseen", async () => {
    await expect(
      reReadExpiredStatuses(earnClusterRpc("devnet"), [null], [], 100n)
    ).resolves.toEqual([null]);
    expect(rpc.requests).toEqual([]);
  });

  it("re-reads only the expired rows at the height's slot and puts each answer in place", async () => {
    rpc.respond("getSignatureStatuses", () => signatureStatusesReplyAt(100, [FINALIZED, null]));

    const statuses = await reReadExpiredStatuses(
      earnClusterRpc("devnet"),
      [null, null, null],
      [
        { index: 1, signature: LANDED },
        { index: 2, signature: ABSENT },
      ],
      100n
    );

    expect(statuses[0]).toBeNull();
    expect(statuses[1]).toMatchObject({ confirmationStatus: "finalized" });
    expect(statuses[2]).toBeNull();
    expect(statusReads().map(({ params }) => params)).toEqual([
      [[LANDED, ABSENT], { searchTransactionHistory: true, minContextSlot: 100 }],
    ]);
  });

  it("refuses an answer from a node behind the height's slot", async () => {
    rpc.respond("getSignatureStatuses", () => signatureStatusesReplyAt(99, [null]));

    await expect(
      reReadExpiredStatuses(
        earnClusterRpc("devnet"),
        [null],
        [{ index: 0, signature: UNKNOWN }],
        100n
      )
    ).rejects.toThrow("minContextSlot");
  });
});
