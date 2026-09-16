import * as spc from "@sdp/private-channels";
import * as solanaRpc from "@sdp/rpc/solana";
import { PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS } from "@sdp/spc-escrow";
import {
  blockhash,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createPrivateChannelTransferRepository,
  mapPrivateChannelDepositRow,
  mapPrivateChannelTransferRow,
  mapPrivateChannelWithdrawalRow,
} from "@/db/repositories";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { createChannelDeposit, listChannelDeposits } from "./deposit";
import type { PrivateChannelProjectRpcClient } from "./project-rpc";
import { createChannelTransfer } from "./transfer";
import { createChannelWithdrawal, listChannelWithdrawals } from "./withdraw";

const scope = { organizationId: "org_pc_execution", projectId: "prj_pc_execution" };
const instanceId = "pci_pc_execution";
const recipient = "So11111111111111111111111111111111111111112";
let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let signTransactions: ReturnType<
  typeof vi.fn<Awaited<ReturnType<typeof generateKeyPairSigner>>["signTransactions"]>
>;
let refresh: ReturnType<typeof vi.fn<() => Promise<string>>>;
let projectRpc: PrivateChannelProjectRpcClient;
let failSend: Error | undefined;
let signedBeforeSend: string[];

beforeEach(async () => {
  await seedTestDatabase(env);
  const generated = await generateKeyPairSigner();
  signTransactions = vi.fn(generated.signTransactions);
  signer = { ...generated, signTransactions };
  refresh = vi.fn(async () => "fresh-jwt");
  failSend = undefined;
  signedBeforeSend = [];
  projectRpc = {
    cluster: "devnet",
    target: {
      providerId: "custom",
      projectId: scope.projectId,
      endpoint: "https://rpc.pc-execution.test",
      endpointLabel: "PC execution test",
      headers: {},
      selectionMode: "project_custom_provider",
    },
    probe: async () => ({ ok: true, latencyMs: 0, version: "test" }),
    rpc: solanaRpc.createRpcFromTransport(
      vi.fn().mockResolvedValue({
        jsonrpc: "2.0",
        id: "pc-execution",
        result: {
          context: { slot: 0 },
          value: {
            owner: PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS,
            data: ["", "base64"],
            executable: false,
            lamports: 0,
            rentEpoch: 0,
            space: 0,
          },
        },
      })
    ),
  };
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'PC execution', 'pc-execution', 'enterprise', 'active')"
      )
      .bind(scope.organizationId),
    db.prepare(
      "INSERT INTO users (id, email, status) VALUES ('usr_pc_execution', 'pc-execution@example.com', 'active')"
    ),
    db
      .prepare(
        "INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by) VALUES (?, ?, 'PC', 'pc-execution', 'sandbox', 'active', 'usr_pc_execution')"
      )
      .bind(scope.projectId, scope.organizationId),
    db
      .prepare(`INSERT INTO private_channel_instances
      (id, organization_id, project_id, gateway_url, auth_url, escrow_program_id, withdraw_program_id, escrow_instance_addr, is_active)
      VALUES (?, ?, ?, 'https://gateway.example', 'https://auth.example', ?, ?, ?, true)`)
      .bind(
        instanceId,
        scope.organizationId,
        scope.projectId,
        PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS,
        signer.address,
        signer.address
      ),
    db
      .prepare(`INSERT INTO private_channels (id, organization_id, project_id, instance_id, name)
      VALUES ('pch_execution', ?, ?, ?, 'PC')`)
      .bind(scope.organizationId, scope.projectId, instanceId),
    db
      .prepare(`INSERT INTO private_channel_users
      (id, organization_id, project_id, instance_id, spc_user_id, spc_username, spc_credential_ciphertext)
      VALUES ('pcu_execution', ?, ?, ?, 'spc_sender', 'sender', 'test'), ('pcu_recipient', ?, ?, ?, 'spc_recipient', 'recipient', 'test')`)
      .bind(
        scope.organizationId,
        scope.projectId,
        instanceId,
        scope.organizationId,
        scope.projectId,
        instanceId
      ),
    db
      .prepare(`INSERT INTO private_channel_verified_wallets (id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey)
      VALUES ('pcvw_execution', ?, ?, 'pcu_recipient', ?, 'wallet_recipient', ?)`)
      .bind(scope.organizationId, scope.projectId, instanceId, recipient),
  ]);
  vi.spyOn(spc, "getChannelTokenBalance").mockResolvedValue({
    tokenAccount: signer.address,
    balance: { amount: "10000000", decimals: 6, uiAmountString: "10" },
  });
  vi.spyOn(solanaRpc, "getRecentBlockhash").mockResolvedValue({
    blockhash: blockhash("11111111111111111111111111111111"),
    lastValidBlockHeight: 100n,
  });
  vi.spyOn(solanaRpc, "sendTransaction").mockImplementation(async (_rpc, bytes) => {
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(bytes));
    const rows = [
      ...(await listChannelDeposits(env, scope)),
      ...(await listChannelWithdrawals(env, scope)),
      ...(await createPrivateChannelTransferRepository(env).listTransfersByProject(scope)).map(
        mapPrivateChannelTransferRow
      ),
    ];
    // Observe through the history interface at the network boundary: crash recovery
    // must already be able to find the transaction that is about to leave SDP.
    expect(rows).toHaveLength(1);
    expect(rows[0].signature).toBe(signature);
    signedBeforeSend.push(signature);
    if (failSend) throw failSend;
    return signature;
  });
  vi.spyOn(solanaRpc, "confirmTransaction").mockImplementation(async (_rpc, signature) => ({
    signature,
    slot: 42n,
    confirmationStatus: "finalized",
    err: null,
  }));
});

afterEach(() => vi.restoreAllMocks());

function execute(kind: "deposit" | "withdrawal" | "transfer") {
  const input = {
    ...scope,
    instance: {
      id: instanceId,
      gatewayUrl: "https://gateway.example",
      escrowProgramId: PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS,
      escrowInstanceAddr: signer.address,
    },
    userId: "usr_pc_execution",
    wallet: {
      id: "cw_execution",
      custodyConfigId: "cfg_execution",
      walletId: "wallet_execution",
      publicKey: signer.address,
      status: "active" as const,
      label: null,
      purpose: null,
      createdAt: new Date().toISOString(),
    },
    signer,
    amount: "1.5",
    idempotencyKey: "idem_execution",
    gatewayAuth: { current: "jwt", refresh, pcUserId: "pcu_execution" },
    projectRpc,
  };
  if (kind === "transfer") {
    return createChannelTransfer(env, {
      ...input,
      channelId: "pch_execution",
      sdpUserId: "usr_pc_execution",
      recipient: {
        privateChannelUserId: "pcu_recipient",
        verifiedWalletId: "pcvw_execution",
        pubkey: recipient,
      },
      onReplay: async (row) => mapPrivateChannelTransferRow(row),
    });
  }
  return kind === "deposit"
    ? createChannelDeposit(env, {
        ...input,
        recipient: signer.address,
        onReplay: async (row) => mapPrivateChannelDepositRow(row),
      })
    : createChannelWithdrawal(env, {
        ...input,
        destination: signer.address,
        onReplay: async (row) => mapPrivateChannelWithdrawalRow(row),
      });
}

describe.each(["deposit", "withdrawal", "transfer"] as const)(
  "Private Channels %s execution",
  (kind) => {
    it("uses its prepared signer and persists the signature before sending", async () => {
      const result = await execute(kind);
      expect(result.status).toBe("confirmed");
      expect(result.signature).toBe(signedBeforeSend[0]);
      expect(signTransactions).toHaveBeenCalledTimes(1);
    });

    it("only lets one simultaneous request sign and send under the same key", async () => {
      const results = await Promise.all([execute(kind), execute(kind)]);
      expect(results[0].id).toBe(results[1].id);
      expect(signTransactions).toHaveBeenCalledTimes(1);
      expect(solanaRpc.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("retains a submitted signature after an unknown send result without signing again", async () => {
      failSend = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      vi.mocked(solanaRpc.confirmTransaction).mockRejectedValue(new Error("network error"));
      const result = await execute(kind);
      expect(result.status).toBe("submitted");
      expect(result.signature).toBe(signedBeforeSend[0]);
      expect(signTransactions).toHaveBeenCalledTimes(1);
      expect(solanaRpc.sendTransaction).toHaveBeenCalledTimes(1);
    });
  }
);

it("keeps the withdrawal signer across one 401 refresh and records the new signature before resending", async () => {
  failSend = Object.assign(new Error("Unauthorized"), { context: { statusCode: 401 } });
  refresh.mockImplementation(async () => {
    failSend = undefined;
    vi.mocked(solanaRpc.getRecentBlockhash).mockResolvedValue({
      blockhash: blockhash(signer.address),
      lastValidBlockHeight: 200n,
    });
    return "fresh-jwt";
  });
  const result = await execute("withdrawal");
  expect(result.status).toBe("confirmed");
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(signTransactions).toHaveBeenCalledTimes(2);
  expect(signedBeforeSend).toHaveLength(2);
  expect(signedBeforeSend[0]).not.toBe(signedBeforeSend[1]);
  expect(result.signature).toBe(signedBeforeSend[1]);
});
