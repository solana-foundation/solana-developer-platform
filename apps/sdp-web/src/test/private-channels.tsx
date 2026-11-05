import type {
  PrivateChannelDeposit,
  PrivateChannelInstance,
  PrivateChannelWithdrawal,
} from "@sdp/types/private-channels";
import {
  usePrivateChannelInstance,
  useWalletSummaries,
} from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";

export const PRIVATE_CHANNELS_INSTANCE_READ = "/api/dashboard/private-channels/instance";
export const WALLET_SUMMARIES_READ = "/api/dashboard/wallets?view=summary";

/** A synthetic connected instance; the fields not under test stay fixed. */
export function privateChannelInstanceFixture(
  instance: Pick<PrivateChannelInstance, "id" | "isActive">
): PrivateChannelInstance {
  return {
    ...instance,
    organizationId: "org_test",
    projectId: "prj_test_sandbox",
    createdBy: "user_test",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    gatewayUrl: "https://gateway.example.test",
    chainRpcUrl: "https://rpc.example.test",
    escrowProgramId: "EscrowProgram111111111111111111111111111111",
    withdrawProgramId: "WithdrawProgram1111111111111111111111111111",
    escrowInstanceAddr: "EscrowInstance11111111111111111111111111111",
    authUrl: "https://auth.example.test",
  };
}

/** A synthetic movement that reads as either a deposit or a withdrawal. */
export function privateChannelMovementFixture(
  movement: Pick<PrivateChannelDeposit, "id" | "status">
): PrivateChannelDeposit & PrivateChannelWithdrawal {
  return {
    ...movement,
    instanceId: "pci_test",
    organizationId: "org_test",
    projectId: "prj_test_sandbox",
    walletId: "wallet_test",
    depositor: "Sender1111111111111111111111111111111111",
    recipient: "Receiver111111111111111111111111111111111",
    owner: "Sender1111111111111111111111111111111111",
    destination: "Receiver111111111111111111111111111111111",
    mint: "Mint111111111111111111111111111111111111111",
    amount: "12",
    signature: null,
    settlementRef: null,
    failureReason: null,
    context: {},
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

/** Keeps the reads a deposit or withdrawal must refresh on screen: the instance and the custody wallets. */
export function MovementReadsProbe() {
  usePrivateChannelInstance(true);
  useWalletSummaries({ includeBalances: false });
  return null;
}

/** Answers a {@link MovementReadsProbe} read; any other path fails the test. */
export function movementReadResponse(path: string): Response {
  if (path === PRIVATE_CHANNELS_INSTANCE_READ) {
    return Response.json({
      data: { instance: privateChannelInstanceFixture({ id: "pci_test", isActive: true }) },
    });
  }
  if (path === WALLET_SUMMARIES_READ) {
    return Response.json({ data: { wallets: [] } });
  }
  throw new Error(`Unexpected dashboard read ${path}`);
}
