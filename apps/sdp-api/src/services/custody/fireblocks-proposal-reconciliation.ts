import type {
  FireblocksProposalsRepository,
  FireblocksSigningProposalRow,
} from "@/db/repositories/fireblocks-proposals.repository";
import { conflict } from "@/lib/errors";
import { isFireblocksSigningFinished } from "@/services/custody/fireblocks-proposal-tracking";
import { createOrgTransferProposalReader } from "@/services/solana/signer";
import type { Env } from "@/types/env";

/** The recorded intent a signing proposal polls against: its original account binding. */
export function fireblocksSigningBinding(row: FireblocksSigningProposalRow) {
  return {
    connectionId: row.connection_id,
    accountFingerprint: row.account_fingerprint,
    vaultAccountId: row.vault_account_id,
    assetId: row.asset_id,
    sourceAddress: row.source_address,
  };
}

/** A read bound to the proposal's recorded intent; the waist re-resolves the live Connection. */
async function signingReader(env: Env, row: FireblocksSigningProposalRow) {
  return createOrgTransferProposalReader(
    env,
    row.organization_id,
    row.project_id,
    row.custody_wallet_id,
    fireblocksSigningBinding(row)
  );
}

export async function readFireblocksSigningProposal(
  env: Env,
  repo: FireblocksProposalsRepository,
  row: FireblocksSigningProposalRow
) {
  const result = await (await signingReader(env, row)).read(row.id);
  if (!result) return null;
  if (
    result.externalTxId !== row.id ||
    result.operation !== row.operation ||
    result.assetId !== row.asset_id ||
    result.source?.type !== "VAULT_ACCOUNT" ||
    result.source.id !== row.vault_account_id ||
    (row.provider_transaction_id !== null && row.provider_transaction_id !== result.id)
  )
    throw conflict("Fireblocks proposal identity changed");
  await repo.observe(row.id, result.id, result.status, isFireblocksSigningFinished(result.status));
  return result;
}

/** Read status only: a recovered signature never resumes a dead request or broadcasts. */
export async function pollFireblocksSigningProposal(
  env: Env,
  repo: FireblocksProposalsRepository,
  row: FireblocksSigningProposalRow
): Promise<{ row: FireblocksSigningProposalRow; polled: boolean }> {
  if (row.finished_at || !(await repo.claimPoll(row.id)))
    return { row: await repo.require(row.id), polled: false };
  await readFireblocksSigningProposal(env, repo, row);
  return { row: await repo.require(row.id), polled: true };
}
