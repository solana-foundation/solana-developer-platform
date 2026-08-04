import * as solanaRpc from "@sdp/rpc/solana";
import type { PrivateChannelBalance } from "@sdp/types";
import {
  type Address,
  address,
  type Blockhash,
  generateKeyPairSigner,
  getBase58Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Signature,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  parseTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreatePrivateChannelTransferInput,
  PrivateChannelTransferRepository,
  PrivateChannelTransferRow,
  UpdatePrivateChannelTransferInput,
} from "@/db/repositories";
import * as repositories from "@/db/repositories";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import type { SpcAuthContext } from "./auth/gateway-auth";
import * as gatewayAuthService from "./auth/gateway-auth";
import * as balanceService from "./balance";
import { buildTokenTransferInstructions, createChannelTransfer } from "./transfer";
import * as transferEvents from "./transfer-events";

const TEST_ENV = {} as Env;
const ORGANIZATION_ID = "org_transfer_test";
const PROJECT_ID = "prj_transfer_test";
const INSTANCE_ID = "pci_transfer_test";
const CHANNEL_ID = "pch_transfer_test";
const RECIPIENT_PC_USER_ID = "pcu_transfer_recipient";
const RECIPIENT_VERIFIED_WALLET_ID = "pcvw_transfer_recipient";
const GATEWAY_URL = "https://gateway.example";
const CHAIN_RPC_URL = "https://api.devnet.solana.com";
const MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SIGNATURE = "1".repeat(64) as Signature;
const GATEWAY_RPC = { kind: "gateway-rpc" };
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;

type TestSigner = Awaited<ReturnType<typeof generateKeyPairSigner>>;

let senderSigner: TestSigner;
let recipient: Address;
let wallet: CustodyWallet;
let auth: SpcAuthContext;
let repo: PrivateChannelTransferRepository;

/** A freshly inserted row, which the repository always writes as `pending`. */
function makePendingRow(input: CreatePrivateChannelTransferInput): PrivateChannelTransferRow {
  return {
    id: "pct_transfer_test",
    organization_id: input.organizationId,
    project_id: input.projectId,
    instance_id: input.instanceId,
    channel_id: input.channelId,
    sender_private_channel_user_id: input.senderPrivateChannelUserId,
    recipient_private_channel_user_id: input.recipientPrivateChannelUserId,
    sender_wallet_id: input.senderWalletId,
    recipient_verified_wallet_id: input.recipientVerifiedWalletId,
    sender: input.sender,
    recipient: input.recipient,
    mint: input.mint,
    amount: input.amount,
    status: "pending",
    signature: null,
    failure_reason: null,
    created_at: "2026-07-28T10:00:00.000Z",
    updated_at: "2026-07-28T10:00:00.000Z",
  };
}

function makeInput(overrides: Partial<Parameters<typeof createChannelTransfer>[1]> = {}) {
  return {
    instance: {
      id: INSTANCE_ID,
      gatewayUrl: GATEWAY_URL,
      chainRpcUrl: CHAIN_RPC_URL,
    },
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    channelId: CHANNEL_ID,
    wallet,
    // Resolved by the route's access seam in production; the service never derives it.
    signer: senderSigner,
    recipient: {
      privateChannelUserId: RECIPIENT_PC_USER_ID,
      verifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
      pubkey: recipient,
    },
    amount: "1.25",
    gatewayAuth: auth,
    ...overrides,
  };
}

function makeBalance(amount = "10000000"): PrivateChannelBalance {
  return {
    owner: senderSigner.address,
    mint: MINT,
    tokenAccount: senderSigner.address,
    amount,
    decimals: 6,
    uiAmount: "10",
  };
}

beforeEach(async () => {
  senderSigner = await generateKeyPairSigner();
  recipient = (await generateKeyPairSigner()).address;
  wallet = {
    id: "cwlt_transfer_test",
    custodyConfigId: "cust_transfer_test",
    walletId: "wallet_transfer_test",
    publicKey: senderSigner.address,
    label: "Sender",
    purpose: "transfer",
    status: "active",
    createdAt: "2026-07-28T10:00:00.000Z",
  };
  auth = {
    current: "spc-jwt",
    refresh: vi.fn(async () => "refreshed-spc-jwt"),
    pcUserId: "pcu_transfer_sender",
  };
  // A minimal stand-in for the real repository: the insert yields a `pending` row
  // and the update applies the patch to it, so tests observe the same two-step
  // write the service performs.
  let inserted: PrivateChannelTransferRow | null = null;
  repo = {
    createTransfer: vi.fn(async (input: CreatePrivateChannelTransferInput) => {
      inserted = makePendingRow(input);
      return inserted;
    }),
    updateTransfer: vi.fn(async (input: UpdatePrivateChannelTransferInput) => {
      if (!inserted || inserted.status !== (input.expectedStatus ?? inserted.status)) {
        return null;
      }
      inserted = {
        ...inserted,
        status: input.status,
        signature: input.signature ?? inserted.signature,
        failure_reason: input.failureReason ?? inserted.failure_reason,
      };
      return inserted;
    }),
  } as unknown as PrivateChannelTransferRepository;

  vi.spyOn(repositories, "createPrivateChannelTransferRepository").mockReturnValue(repo);
  vi.spyOn(balanceService, "getChannelBalance").mockResolvedValue(makeBalance());
  vi.spyOn(gatewayAuthService, "withGatewayRpc").mockImplementation(
    async (_env, _gatewayUrl, _context, run) => run(GATEWAY_RPC as never)
  );
  vi.spyOn(solanaRpc, "getRecentBlockhash").mockResolvedValue({
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 100n,
  });
  vi.spyOn(solanaRpc, "sendTransaction").mockResolvedValue(SIGNATURE);
  // Default: SPC executed the transaction cleanly. `confirmationStatus` is always
  // `finalized` on SPC — one sequencer, no fork choice — so a found status is final.
  vi.spyOn(solanaRpc, "confirmTransaction").mockResolvedValue({
    signature: SIGNATURE,
    slot: 42n,
    confirmationStatus: "finalized",
    err: null,
  });
  vi.spyOn(transferEvents, "emitTransferEvent").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTokenTransferInstructions", () => {
  it("builds an idempotent destination ATA create before a classic SPL transfer", async () => {
    const built = await buildTokenTransferInstructions({
      signer: senderSigner,
      mint: MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      decimals: 6,
      recipient,
      amountBaseUnits: 1_250_000n,
    });
    const [expectedSource] = await findAssociatedTokenPda({
      owner: senderSigner.address,
      mint: MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [expectedDestination] = await findAssociatedTokenPda({
      owner: recipient,
      mint: MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    expect(built.sourceTokenAccount).toBe(expectedSource);
    expect(built.destinationTokenAccount).toBe(expectedDestination);
    expect(built.instructions[0].programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(built.instructions[1].programAddress).toBe(TOKEN_PROGRAM_ADDRESS);

    const createAta = parseCreateAssociatedTokenIdempotentInstruction(built.instructions[0]);
    expect(createAta.accounts.payer.address).toBe(senderSigner.address);
    expect(createAta.accounts.ata.address).toBe(expectedDestination);

    // Classic stays on plain `Transfer`: SPC validates instruction encoding against
    // a program allowlist, so the path already proven to pass must not change.
    // The builder returns a union of the two programs' instruction shapes, and the
    // branded `Address` literals don't narrow by comparison — so the cast is to the
    // parser's own input type, guarded by the programAddress assertion above.
    const transfer = parseTransferInstruction(
      built.instructions[1] as Parameters<typeof parseTransferInstruction>[0]
    );
    expect(transfer.accounts.source.address).toBe(expectedSource);
    expect(transfer.accounts.destination.address).toBe(expectedDestination);
    expect(transfer.accounts.authority.address).toBe(senderSigner.address);
    expect(transfer.data.amount).toBe(1_250_000n);
  });

  it("derives token-2022 ATAs under that program and uses TransferChecked", async () => {
    const built = await buildTokenTransferInstructions({
      signer: senderSigner,
      mint: MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      decimals: 6,
      recipient,
      amountBaseUnits: 1_250_000n,
    });
    const [expectedSource] = await findAssociatedTokenPda({
      owner: senderSigner.address,
      mint: MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const [expectedDestination] = await findAssociatedTokenPda({
      owner: recipient,
      mint: MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    // The whole point of threading the program: the same (owner, mint) derives a
    // DIFFERENT account under token-2022, so a classic assumption reads an address
    // that holds nothing.
    const [classicSource] = await findAssociatedTokenPda({
      owner: senderSigner.address,
      mint: MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    expect(expectedSource).not.toBe(classicSource);

    expect(built.sourceTokenAccount).toBe(expectedSource);
    expect(built.destinationTokenAccount).toBe(expectedDestination);
    expect(built.instructions[1].programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS);

    const transfer = parseTransferCheckedInstruction(
      built.instructions[1] as Parameters<typeof parseTransferCheckedInstruction>[0]
    );
    expect(transfer.accounts.source.address).toBe(expectedSource);
    expect(transfer.accounts.destination.address).toBe(expectedDestination);
    expect(transfer.accounts.mint.address).toBe(MINT);
    expect(transfer.data.amount).toBe(1_250_000n);
    expect(transfer.data.decimals).toBe(6);
  });
});

describe("createChannelTransfer", () => {
  it.each([
    ["malformed syntax", "1.2.3", "Invalid decimal amount"],
    ["excess default-USDC precision", "0.0000001", "Amount has too many decimal places"],
  ])("rejects %s before sending or persistence", async (_case, amount, message) => {
    await expect(createChannelTransfer(TEST_ENV, makeInput({ amount }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message,
    });

    expect(solanaRpc.sendTransaction).not.toHaveBeenCalled();
    expect(repo.createTransfer).not.toHaveBeenCalled();
  });

  it("rejects insufficient SPC balance before sending or persistence", async () => {
    vi.mocked(balanceService.getChannelBalance).mockResolvedValue(makeBalance("1249999"));

    await expect(createChannelTransfer(TEST_ENV, makeInput())).rejects.toMatchObject({
      code: "INSUFFICIENT_TOKEN_BALANCE",
    });

    expect(solanaRpc.sendTransaction).not.toHaveBeenCalled();
    expect(repo.createTransfer).not.toHaveBeenCalled();
  });

  it("persists the transfer before sending, then records submitted and confirmed", async () => {
    const result = await createChannelTransfer(TEST_ENV, makeInput());

    expect(solanaRpc.sendTransaction).toHaveBeenCalledWith(GATEWAY_RPC, expect.any(Uint8Array));
    expect(repo.createTransfer).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: CHANNEL_ID,
      senderPrivateChannelUserId: auth.pcUserId,
      recipientPrivateChannelUserId: RECIPIENT_PC_USER_ID,
      senderWalletId: wallet.walletId,
      recipientVerifiedWalletId: RECIPIENT_VERIFIED_WALLET_ID,
      sender: senderSigner.address,
      recipient,
      mint: MINT,
      amount: "1.25",
    });
    // The audit row must exist before anything can move funds.
    expect(vi.mocked(repo.createTransfer).mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      vi.mocked(solanaRpc.sendTransaction).mock.invocationCallOrder[0] ?? 0
    );
    expect(repo.updateTransfer).toHaveBeenNthCalledWith(1, {
      id: "pct_transfer_test",
      status: "submitted",
      signature: SIGNATURE,
      failureReason: null,
      expectedStatus: "pending",
    });
    // The confirm write is CAS'd on `submitted` and leaves the signature in place.
    expect(repo.updateTransfer).toHaveBeenNthCalledWith(2, {
      id: "pct_transfer_test",
      status: "confirmed",
      expectedStatus: "submitted",
    });
    expect(transferEvents.emitTransferEvent).toHaveBeenNthCalledWith(
      1,
      TEST_ENV,
      expect.objectContaining({ status: "submitted", signature: SIGNATURE }),
      "transfer.transfer.submitted",
      "pending"
    );
    expect(transferEvents.emitTransferEvent).toHaveBeenNthCalledWith(
      2,
      TEST_ENV,
      expect.objectContaining({ status: "confirmed", signature: SIGNATURE }),
      "transfer.transfer.confirmed",
      "confirmed"
    );
    expect(result).toMatchObject({ status: "confirmed", signature: SIGNATURE });

    const transaction = getTransactionDecoder().decode(
      vi.mocked(solanaRpc.sendTransaction).mock.calls[0]?.[1] as Uint8Array
    );
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    expect(transaction.signatures[senderSigner.address]).not.toBeNull();
    expect(message.version).toBe(0);
  });

  // The blockhash must be fetched inside the same gateway unit as the send: SPC's
  // dedup stage silently drops a transaction whose blockhash left the live window.
  it("fetches the blockhash and sends within one gateway unit", async () => {
    await createChannelTransfer(TEST_ENV, makeInput());

    expect(gatewayAuthService.withGatewayRpc).toHaveBeenCalledTimes(2);
    const blockhashOrder = vi.mocked(solanaRpc.getRecentBlockhash).mock.invocationCallOrder[0] ?? 0;
    const sendOrder = vi.mocked(solanaRpc.sendTransaction).mock.invocationCallOrder[0] ?? 0;
    const firstUnitOrder =
      vi.mocked(gatewayAuthService.withGatewayRpc).mock.invocationCallOrder[0] ?? 0;
    const confirmUnitOrder =
      vi.mocked(gatewayAuthService.withGatewayRpc).mock.invocationCallOrder[1] ?? 0;
    // Blockhash AND send both happen inside the first unit, before the confirm unit.
    expect(firstUnitOrder).toBeLessThan(blockhashOrder);
    expect(blockhashOrder).toBeLessThan(sendOrder);
    expect(sendOrder).toBeLessThan(confirmUnitOrder);
  });

  it("records an execution error as failed with the real transaction error", async () => {
    vi.mocked(solanaRpc.confirmTransaction).mockResolvedValue({
      signature: SIGNATURE,
      slot: 42n,
      confirmationStatus: "finalized",
      err: { InstructionError: [1, { Custom: 1 }] },
    });

    const result = await createChannelTransfer(TEST_ENV, makeInput());

    expect(result).toMatchObject({
      status: "failed",
      failureReason: '{"InstructionError":[1,{"Custom":1}]}',
    });
    expect(transferEvents.emitTransferEvent).toHaveBeenLastCalledWith(
      TEST_ENV,
      expect.objectContaining({ status: "failed" }),
      "transfer.transfer.failed",
      "failed"
    );
  });

  // A dedup drop (stale blockhash / duplicate) means the transaction never appears,
  // so the confirm read times out. That is NOT evidence of success or of failure.
  it("leaves a transfer submitted when the confirm read returns no verdict", async () => {
    vi.mocked(solanaRpc.confirmTransaction).mockRejectedValue(new Error("confirmation timed out"));

    const result = await createChannelTransfer(TEST_ENV, makeInput());

    expect(result).toMatchObject({ status: "submitted", signature: SIGNATURE });
    expect(vi.mocked(repo.updateTransfer).mock.calls.map(([call]) => call.status)).toEqual([
      "submitted",
    ]);
    expect(
      vi.mocked(transferEvents.emitTransferEvent).mock.calls.map(([, , type]) => type)
    ).toEqual(["transfer.transfer.submitted"]);
  });

  // SPC sheds at ingress before the dedup insert, so nothing was queued and the
  // same transfer is immediately resubmittable — the reason must say so.
  it("marks a capacity shed as retryable rather than an opaque rejection", async () => {
    vi.mocked(solanaRpc.sendTransaction).mockRejectedValueOnce(
      Object.assign(new Error("Node at capacity, retry shortly"), { code: -32003 })
    );

    const result = await createChannelTransfer(TEST_ENV, makeInput());

    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe(
      "SPC is at capacity and did not accept the transfer. Try again shortly."
    );
  });

  it("records an SPC error as failed, emits a failed event, and allows a later retry", async () => {
    vi.mocked(solanaRpc.sendTransaction)
      .mockRejectedValueOnce(new Error("SPC rejected transfer"))
      .mockResolvedValueOnce(SIGNATURE);

    const failed = await createChannelTransfer(TEST_ENV, makeInput());
    const retried = await createChannelTransfer(TEST_ENV, makeInput());

    expect(failed).toMatchObject({
      status: "failed",
      failureReason: "SPC rejected transfer",
    });
    expect(retried).toMatchObject({ status: "confirmed", signature: SIGNATURE });
    expect(repo.updateTransfer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "failed",
        failureReason: "SPC rejected transfer",
      })
    );
    expect(repo.updateTransfer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: "submitted", signature: SIGNATURE })
    );
    expect(repo.updateTransfer).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ status: "confirmed", expectedStatus: "submitted" })
    );
    expect(transferEvents.emitTransferEvent).toHaveBeenNthCalledWith(
      1,
      TEST_ENV,
      expect.objectContaining({ status: "failed" }),
      "transfer.transfer.failed",
      "failed"
    );
    expect(solanaRpc.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("fails the request without sending when the pending row cannot be stored", async () => {
    vi.mocked(repo.createTransfer).mockResolvedValueOnce(null);

    await expect(createChannelTransfer(TEST_ENV, makeInput())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });

    // Nothing was broadcast, so there is no funds movement to reconcile.
    expect(solanaRpc.sendTransaction).not.toHaveBeenCalled();
  });

  it("leaves the row pending and still returns it when the status write fails after accept", async () => {
    vi.mocked(repo.updateTransfer).mockRejectedValueOnce(new Error("database unavailable"));

    const result = await createChannelTransfer(TEST_ENV, makeInput());

    expect(solanaRpc.sendTransaction).toHaveBeenCalledOnce();
    // The id is the real persisted one, so an operator can find the stuck row.
    expect(result).toMatchObject({
      id: "pct_transfer_test",
      status: "pending",
      amount: "1.25",
    });
  });
});
