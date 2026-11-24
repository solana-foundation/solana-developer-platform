import * as rpcFactory from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import { VERDICT_HISTORY_HORIZON_BLOCKS } from "@sdp/rpc/solana";
import {
  getBase58Decoder,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
} from "@solana/kit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OperationScope } from "@/db/repositories/operations.repository";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import { rootLogger } from "@/runtime/logger";
import {
  epochInfoResult,
  installClusterRpcResponder,
  type StubSignatureStatus,
  signatureStatusesRead,
  signatureStatusesReply,
  signatureStatusesReplyAt,
} from "@/test/helpers/cluster-rpc";
import { createOperationObservationRpc } from "./operation-observation-rpc";

const scope: OperationScope = {
  organizationId: "org",
  projectId: "project",
  environment: "sandbox",
};
const signatures = [1, 2].map((value) => getBase58Decoder().decode(new Uint8Array(64).fill(value)));
const first = signatures[0];
const second = signatures[1];
if (first === undefined || second === undefined) throw new Error("Signature fixtures are missing");
const scoped = <T>(work: () => T) =>
  runInClusterScope({ projectId: null, environment: "sandbox" }, work);
const unavailable = {
  error: { code: SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, message: "RPC unavailable" },
};
const landed: StubSignatureStatus = {
  slot: 90,
  confirmations: null,
  confirmationStatus: "finalized",
  err: null,
};
// The send's blockhash is valid through block height 1,000; finalized reads come from slot 2,000.
const LAST_VALID_BLOCK_HEIGHT = 1_000n;
const FINALIZED_SLOT = 2_000;
const HORIZON_EDGE_HEIGHT = Number(LAST_VALID_BLOCK_HEIGHT + VERDICT_HISTORY_HORIZON_BLOCKS);

afterEach(() => {
  vi.restoreAllMocks();
});

function spyOnLog(level: "warn" | "error") {
  const log = vi.spyOn(rootLogger, level).mockImplementation(() => undefined);
  onTestFinished(() => log.mockRestore());
  return log;
}

describe("scoped operation observations", () => {
  const rpc = installClusterRpcResponder();
  const requestsFor = (method: string) =>
    rpc.requests.filter((request) => request.method === method);

  it("creates no client until needed and shares one client, height and batched status read", async () =>
    scoped(async () => {
      const clients = vi.spyOn(rpcFactory, "createClusterRpc");
      rpc.answer("getBlockHeight", 100);
      rpc.respondSignatureStatuses(() => null);
      const reads = createOperationObservationRpc();
      expect(clients).not.toHaveBeenCalled();
      const values = await Promise.all([
        reads.confirmedHeight(scope),
        reads.confirmedHeight(scope),
        reads.hasSignature(scope, first),
        reads.hasSignature(scope, second),
        reads.hasSignature(scope, first),
      ]);
      expect(values).toEqual([100n, 100n, false, false, false]);
      expect(clients).toHaveBeenCalledTimes(1);
      expect(requestsFor("getBlockHeight")).toHaveLength(1);
      expect(requestsFor("getSignatureStatuses").map(signatureStatusesRead)).toEqual([
        { cluster: "devnet", signatures: [first, second], searchTransactionHistory: true },
      ]);
    }));

  it("isolates org, project and recorded-principal clients and batches", async () =>
    scoped(async () => {
      const clients = vi.spyOn(rpcFactory, "createClusterRpc");
      rpc.respondSignatureStatuses(() => null);
      const reads = createOperationObservationRpc();
      await Promise.all([
        reads.hasSignature(scope, first),
        reads.hasSignature({ ...scope, organizationId: "other-org" }, first),
        reads.hasSignature({ ...scope, projectId: "other-project" }, first),
        runAsMoneyPrincipal({ kind: "member", userId: "other-user" }, () =>
          reads.hasSignature(scope, first)
        ),
      ]);
      expect(clients).toHaveBeenCalledTimes(4);
      expect(requestsFor("getSignatureStatuses")).toHaveLength(4);
    }));

  it("refuses reuse after the cluster or open project scope changes", async () => {
    const clients = vi.spyOn(rpcFactory, "createClusterRpc");
    const reads = scoped(() => createOperationObservationRpc());
    await expect(
      runInClusterScope({ projectId: null, environment: "production" }, () =>
        reads.confirmedHeight({ ...scope, environment: "production" })
      )
    ).rejects.toThrow("scope changed");
    await expect(
      runInClusterScope({ projectId: "project", environment: "sandbox" }, () =>
        reads.hasSignature(scope, first)
      )
    ).rejects.toThrow("scope changed");
    await expect(
      runInClusterScope({ projectId: "project", environment: "sandbox" }, () =>
        reads.unsentVerdict(scope, first, LAST_VALID_BLOCK_HEIGHT)
      )
    ).rejects.toThrow("scope changed");
    expect(clients).not.toHaveBeenCalled();
    expect(rpc.requests).toHaveLength(0);
  });

  it("does not retain failed height reads or reuse a height for another principal", async () =>
    scoped(async () => {
      const clients = vi.spyOn(rpcFactory, "createClusterRpc");
      let attempts = 0;
      rpc.respond("getBlockHeight", () => (attempts++ === 0 ? unavailable : { result: 100 }));
      const reads = createOperationObservationRpc();
      await expect(reads.confirmedHeight(scope)).rejects.toThrow();
      expect(await reads.confirmedHeight(scope)).toBe(100n);
      await runAsMoneyPrincipal({ kind: "member", userId: "other-user" }, () =>
        reads.confirmedHeight(scope)
      );
      expect(requestsFor("getBlockHeight")).toHaveLength(3);
      expect(clients).toHaveBeenCalledTimes(2);
    }));

  it("does not cache missing signatures or failed status reads", async () =>
    scoped(async () => {
      const clients = vi.spyOn(rpcFactory, "createClusterRpc");
      const replies = [
        unavailable,
        signatureStatusesReply([null]),
        signatureStatusesReply([landed]),
      ];
      rpc.respond("getSignatureStatuses", () => replies.shift() ?? unavailable);
      const reads = createOperationObservationRpc();
      await expect(reads.hasSignature(scope, first)).rejects.toThrow();
      expect(await reads.hasSignature(scope, first)).toBe(false);
      expect(await reads.hasSignature(scope, first)).toBe(true);
      expect(requestsFor("getSignatureStatuses")).toHaveLength(3);
      expect(clients).toHaveBeenCalledTimes(1);
    }));

  it("rejects an incomplete batch without interpreting it as signature absence", async () =>
    scoped(async () => {
      const replies = [signatureStatusesReply([]), signatureStatusesReply([null])];
      rpc.respond("getSignatureStatuses", () => replies.shift() ?? unavailable);
      const reads = createOperationObservationRpc();
      await expect(reads.hasSignature(scope, first)).rejects.toThrow(
        "Incomplete operation signature statuses"
      );
      expect(await reads.hasSignature(scope, first)).toBe(false);
    }));

  it("caps each RPC request at 256 distinct signatures", async () =>
    scoped(async () => {
      const clients = vi.spyOn(rpcFactory, "createClusterRpc");
      rpc.respondSignatureStatuses(() => null);
      const reads = createOperationObservationRpc();
      const values = Array.from({ length: 257 }, (_, index) => {
        const bytes = new Uint8Array(64).fill(1);
        bytes[0] = index % 256;
        bytes[1] = Math.floor(index / 256);
        return getBase58Decoder().decode(bytes);
      });
      await Promise.all(values.map((value) => reads.hasSignature(scope, value)));
      expect(
        requestsFor("getSignatureStatuses").map(
          (request) => signatureStatusesRead(request).signatures.length
        )
      ).toEqual([256, 1]);
      expect(clients).toHaveBeenCalledTimes(1);
    }));
});

describe("unsent transaction absence proof", () => {
  const rpc = installClusterRpcResponder();
  const historyReads = () =>
    rpc.requests
      .filter(({ method }) => method === "getEpochInfo" || method === "getSignatureStatuses")
      .map(({ method, params }) => ({ method, params }));

  function answerChain(blockHeight: number, status: StubSignatureStatus | null) {
    rpc.answer("getEpochInfo", epochInfoResult({ absoluteSlot: FINALIZED_SLOT, blockHeight }));
    rpc.respond("getSignatureStatuses", () => signatureStatusesReplyAt(FINALIZED_SLOT, [status]));
  }

  const verdict = (value: string) =>
    scoped(() =>
      createOperationObservationRpc().unsentVerdict(scope, value, LAST_VALID_BLOCK_HEIGHT)
    );

  it("proves nothing while the finalized height has not passed the expiry", async () => {
    answerChain(Number(LAST_VALID_BLOCK_HEIGHT), null);
    expect(await verdict(first)).toBe("pending");
    expect(historyReads()).toEqual([{ method: "getEpochInfo", params: [] }]);
  });

  it("keeps a single endpoint's floored history miss unresolved, even inside the horizon", async () => {
    answerChain(HORIZON_EDGE_HEIGHT, null);
    const warn = spyOnLog("warn");
    expect(await verdict(first)).toBe("pending");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_earn_operation_unsent_uncorroborated",
        answering_endpoint_count: 1,
      }),
      "sdp_api_earn_operation_unsent_uncorroborated"
    );
    expect(historyReads()).toEqual([
      { method: "getEpochInfo", params: [] },
      {
        method: "getSignatureStatuses",
        params: [
          [first],
          {
            searchTransactionHistory: true,
            minContextSlot: FINALIZED_SLOT,
            commitment: "finalized",
          },
        ],
      },
    ]);
  });

  it("proves expiry when two distinct endpoints corroborate the floored history miss", async () => {
    answerChain(HORIZON_EDGE_HEIGHT, null);
    const history = vi
      .spyOn(rpcFactory, "getSignatureStatusesFromEveryEndpoint")
      .mockImplementation(async () => {
        expect(historyReads()).toEqual([{ method: "getEpochInfo", params: [] }]);
        return [{ kind: "absent", answeringEndpointCount: 2 }];
      });
    expect(await verdict(first)).toBe("expired");
    expect(history).toHaveBeenCalledExactlyOnceWith([first], {
      minContextSlot: BigInt(FINALIZED_SLOT),
      commitment: "finalized",
    });
  });

  it("reports a send an endpoint's floored history holds as landed", async () => {
    answerChain(Number(LAST_VALID_BLOCK_HEIGHT) + 1, landed);
    expect(await verdict(first)).toBe("landed");
  });

  it("keeps waiting, and warns, when an endpoint cannot answer at the floor", async () => {
    rpc.answer(
      "getEpochInfo",
      epochInfoResult({
        absoluteSlot: FINALIZED_SLOT,
        blockHeight: Number(LAST_VALID_BLOCK_HEIGHT) + 1,
      })
    );
    rpc.respond("getSignatureStatuses", () => ({
      error: {
        code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
        message: "Transaction history is not available from this node",
      },
    }));
    const warn = spyOnLog("warn");
    expect(await verdict(first)).toBe("pending");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_earn_operation_unsent_unresolved",
        signature: first,
        min_context_slot: String(FINALIZED_SLOT),
      }),
      "sdp_api_earn_operation_unsent_unresolved"
    );
  });

  it("keeps waiting when the answering node is behind the finalized floor", async () => {
    rpc.answer(
      "getEpochInfo",
      epochInfoResult({
        absoluteSlot: FINALIZED_SLOT,
        blockHeight: Number(LAST_VALID_BLOCK_HEIGHT) + 1,
      })
    );
    rpc.respond("getSignatureStatuses", () => signatureStatusesReplyAt(FINALIZED_SLOT - 1, [null]));
    spyOnLog("warn");
    expect(await verdict(first)).toBe("pending");
  });

  it("keeps waiting, and alerts, when the send expired past the history horizon", async () => {
    answerChain(HORIZON_EDGE_HEIGHT + 1, null);
    const error = spyOnLog("error");
    expect(await verdict(first)).toBe("pending");
    expect(error).toHaveBeenCalledWith(
      {
        event: "sdp_api_earn_operation_unsent_verdict_unprovable",
        environment: scope.environment,
        signature: first,
        last_valid_block_height: String(LAST_VALID_BLOCK_HEIGHT),
        finalized_block_height: String(HORIZON_EDGE_HEIGHT + 1),
        min_context_slot: String(FINALIZED_SLOT),
      },
      "sdp_api_earn_operation_unsent_verdict_unprovable"
    );
  });

  it("shares one finalized height read across a run and keeps none that failed", async () =>
    scoped(async () => {
      let attempts = 0;
      rpc.respond("getEpochInfo", () =>
        attempts++ === 0
          ? unavailable
          : {
              result: epochInfoResult({
                absoluteSlot: FINALIZED_SLOT,
                blockHeight: Number(LAST_VALID_BLOCK_HEIGHT),
              }),
            }
      );
      const reads = createOperationObservationRpc();
      await expect(reads.unsentVerdict(scope, first, LAST_VALID_BLOCK_HEIGHT)).rejects.toThrow();
      expect(
        await Promise.all([
          reads.unsentVerdict(scope, first, LAST_VALID_BLOCK_HEIGHT),
          reads.unsentVerdict(scope, second, LAST_VALID_BLOCK_HEIGHT),
        ])
      ).toEqual(["pending", "pending"]);
      expect(rpc.requests.filter(({ method }) => method === "getEpochInfo")).toHaveLength(2);
    }));
});
