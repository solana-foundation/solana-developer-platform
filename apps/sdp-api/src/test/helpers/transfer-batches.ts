import { getDb } from "@/db/client";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import type { Env } from "@/types/env";

/**
 * Seed a processing transfer batch whose one processing recipient is linked to the chunk transfer
 * `chunk.transferId`, with the source custody wallet and counterparty account its foreign keys
 * need. Every seeded id derives from the transfer id. The chunk's transfer row must exist first.
 *
 * @param env - Test environment bindings.
 * @param chunk - The chunk transfer and the project it belongs to.
 * @param chunk.organizationId - The organization that owns the project.
 * @param chunk.projectId - The project every seeded row belongs to.
 * @param chunk.createdBy - The user recorded as the counterparty's creator.
 * @param chunk.transferId - The existing `transfer_batch` transfer the recipient links to.
 * @param chunk.sourceAddress - The source custody wallet's address.
 * @param chunk.destinationAddress - The recipient's payout address.
 * @returns The seeded batch's id.
 */
export async function seedProcessingBatchChunk(
  env: Env,
  chunk: {
    organizationId: string;
    projectId: string;
    createdBy: string;
    transferId: string;
    sourceAddress: string;
    destinationAddress: string;
  }
): Promise<string> {
  const custodyConfigId = `cfg_${chunk.transferId}`;
  const custodyWalletId = `cwlt_${chunk.transferId}`;
  const walletId = `wallet_${chunk.transferId}`;
  const counterpartyId = `cpty_${chunk.transferId}`;
  const counterpartyAccountId = `cpacct_${chunk.transferId}`;
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: custodyConfigId,
        organizationId: chunk.organizationId,
        projectId: chunk.projectId,
        provider: "local",
        configEncrypted: "encrypted",
        status: "active",
      },
    ],
    wallets: [
      {
        id: custodyWalletId,
        owner: { kind: "config", custodyConfigId },
        walletId,
        publicKey: chunk.sourceAddress,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
  await seedProjectCryptoWalletCounterparty(getDb(env), {
    organizationId: chunk.organizationId,
    projectId: chunk.projectId,
    createdBy: chunk.createdBy,
    counterpartyId,
    counterpartyAccountId,
    walletAddress: chunk.destinationAddress,
  });
  const { batch } = await createPostgresPaymentTransferBatchesRepository(
    getDb(env)
  ).createTransferBatchWithRecipients({
    batch: {
      organizationId: chunk.organizationId,
      projectId: chunk.projectId,
      sourceCustodyWalletId: custodyWalletId,
      sourceWalletId: walletId,
      sourceAddress: chunk.sourceAddress,
      token: "SOL",
      status: "processing",
    },
    recipients: [
      {
        organizationId: chunk.organizationId,
        projectId: chunk.projectId,
        transferId: chunk.transferId,
        counterpartyId,
        counterpartyAccountId,
        destinationAddress: chunk.destinationAddress,
        amount: "1",
        status: "processing",
      },
    ],
  });
  return batch.id;
}
