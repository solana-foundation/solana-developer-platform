import type { TokenTransaction } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import type { AuditService } from "@/services/audit.service";
import type { TokenService } from "@/services/token.service";
import {
  parseSettledTransactionEvidence,
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

const pendingTransaction: TokenTransaction = {
  id: "ttx_settled_replay",
  tokenId: "tok_settled_replay",
  organizationId: "org_settled_replay",
  type: "burn",
  status: "pending",
  idempotencyKey: "settled-replay",
  idempotencyFingerprint: "fingerprint",
  signature: null,
  serializedTx: null,
  params: { amount: "1" },
  slot: null,
  blockTime: null,
  fee: null,
  error: null,
  initiatedByKeyId: "key_settled_replay",
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

describe("settled issuance transaction recovery", () => {
  it("accepts only complete, safely representable settlement evidence", () => {
    expect(parseSettledTransactionEvidence({ signature: "sig", slot: "42" })).toEqual({
      signature: "sig",
      slot: 42,
    });
    expect(parseSettledTransactionEvidence({ signature: "", slot: "42" })).toBeNull();
    expect(parseSettledTransactionEvidence({ signature: "sig", slot: "not-a-slot" })).toBeNull();
    expect(
      parseSettledTransactionEvidence({
        signature: "sig",
        slot: Number.MAX_SAFE_INTEGER + 1,
      })
    ).toBeNull();
  });

  it("repairs a pending transaction from its durable successful outcome", async () => {
    const updateTransaction = vi.fn().mockResolvedValue({
      ...pendingTransaction,
      status: "confirmed",
      signature: "sig_settled",
      slot: 123,
    });
    const findCriticalOutcome = vi.fn().mockResolvedValue({
      status: "success",
      metadata: { signature: "sig_settled", slot: "123" },
    });

    const recovered = await recoverSettledTransactionReplay({
      auditService: { findCriticalOutcome } as unknown as AuditService,
      tokenService: { updateTransaction } as unknown as TokenService,
      transaction: pendingTransaction,
      action: "burn",
    });

    expect(findCriticalOutcome).toHaveBeenCalledWith({
      organizationId: pendingTransaction.organizationId,
      action: "burn",
      resourceType: "token_transaction",
      resourceId: pendingTransaction.id,
    });
    expect(updateTransaction).toHaveBeenCalledWith(pendingTransaction.id, {
      status: "confirmed",
      signature: "sig_settled",
      slot: 123,
    });
    expect(recovered).toMatchObject({
      status: "confirmed",
      signature: "sig_settled",
      slot: 123,
    });
  });

  it("repairs from journaled chain evidence when the terminal audit outcome is missing", async () => {
    const journaledTransaction = {
      ...pendingTransaction,
      signature: "sig_journaled",
      slot: 321,
    };
    const updateTransaction = vi.fn().mockResolvedValue({
      ...journaledTransaction,
      status: "confirmed",
    });
    const findCriticalOutcome = vi.fn();

    const recovered = await recoverSettledTransactionReplay({
      auditService: { findCriticalOutcome } as unknown as AuditService,
      tokenService: { updateTransaction } as unknown as TokenService,
      transaction: journaledTransaction,
      action: "burn",
    });

    expect(findCriticalOutcome).not.toHaveBeenCalled();
    expect(updateTransaction).toHaveBeenCalledWith(journaledTransaction.id, {
      status: "confirmed",
      signature: "sig_journaled",
      slot: 321,
    });
    expect(recovered.status).toBe("confirmed");
  });

  it("returns confirmed evidence when the repair write is temporarily unavailable", async () => {
    const recovered = await recoverSettledTransactionReplay({
      auditService: {
        findCriticalOutcome: vi.fn().mockResolvedValue({
          status: "success",
          metadata: { signature: "sig_settled", slot: "123" },
        }),
      } as unknown as AuditService,
      tokenService: {
        updateTransaction: vi.fn().mockRejectedValue(new Error("database unavailable")),
      } as unknown as TokenService,
      transaction: pendingTransaction,
      action: "burn",
    });

    expect(recovered).toMatchObject({
      status: "confirmed",
      signature: "sig_settled",
      slot: 123,
      error: null,
    });
  });

  it("durably records settlement before attempting the terminal audit outcome", async () => {
    const order: string[] = [];
    const updateTransaction = vi.fn().mockImplementation(async () => {
      order.push("transaction");
      return { ...pendingTransaction, status: "confirmed" };
    });
    const persistOutcome = vi.fn().mockImplementation(async () => {
      order.push("outcome");
      return false;
    });

    const settled = await persistSettledTransactionThenOutcome({
      tokenService: { updateTransaction } as unknown as TokenService,
      transaction: pendingTransaction,
      evidence: { signature: "sig_settled", slot: 123 },
      persistOutcome,
    });

    expect(order).toEqual(["transaction", "outcome"]);
    expect(settled.status).toBe("confirmed");
  });

  it("still attempts the audit fallback when transaction persistence is unavailable", async () => {
    const persistOutcome = vi.fn().mockResolvedValue(true);

    const settled = await persistSettledTransactionThenOutcome({
      tokenService: {
        updateTransaction: vi.fn().mockRejectedValue(new Error("database unavailable")),
      } as unknown as TokenService,
      transaction: pendingTransaction,
      evidence: { signature: "sig_settled", slot: 123 },
      persistOutcome,
    });

    expect(persistOutcome).toHaveBeenCalledOnce();
    expect(settled).toMatchObject({
      status: "confirmed",
      signature: "sig_settled",
      slot: 123,
    });
  });

  it("fails closed when neither transaction evidence nor the audit outcome is durable", async () => {
    await expect(
      persistSettledTransactionThenOutcome({
        tokenService: {
          updateTransaction: vi.fn().mockRejectedValue(new Error("database unavailable")),
        } as unknown as TokenService,
        transaction: pendingTransaction,
        evidence: { signature: "sig_settled", slot: 123 },
        persistOutcome: vi.fn().mockResolvedValue(false),
      })
    ).rejects.toMatchObject({
      name: "AuditPersistenceError",
    });
  });
});
