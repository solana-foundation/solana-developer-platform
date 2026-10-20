/**
 * The only API implementation boundary consumed by @sdp/api-integration.
 * Keep this facade intentionally small and integration-test specific.
 */

import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "@sdp/dvp";
import { supportsVaultDirect } from "@sdp/earn/capabilities";
import { createKoraAdapter, KORA_ENV_KEYS, resolveKoraEndpoint } from "@sdp/fee-payment";
import { KoraAdapter } from "@sdp/fee-payment/kora.adapter";
import { hashString } from "@sdp/payments/hash";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import { KoraClient } from "@solana/kora";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { closeDatabasePools, getDb } from "@/db/client";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { SponsorshipBudgetRepository } from "@/db/repositories/sponsorship-budget.repository";
import { app } from "@/index";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import { runInEachClusterScope } from "@/runtime/cluster-scope-runs";
import { closeAllRedisClients, createKVStoreSet } from "@/runtime/kv-redis";
import { createSigningService } from "@/services/domain/signing.service";
import { resolveEarnExecutionClient } from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { depositIntoVault } from "@/services/earn/vault-deposit.service";
import {
  buildExternalWalletDepositTransaction,
  buildExternalWalletWithdrawalTransaction,
  submitExternalWalletDeposit,
  submitExternalWalletWithdrawal,
} from "@/services/earn/vault-external-wallet.service";
import { withdrawFromVault } from "@/services/earn/vault-withdraw.service";
import { createMosaicService } from "@/services/issuance/mosaic";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { CustodyConfigStore, type CustodyWallet } from "@/services/stores/custody-config.store";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
} from "@/test/fixtures/tokens";
import { ensureTestClerkIssuer, signTestClerkJwt } from "@/test/helpers/clerk";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

export type ApiTestEnv = Env;
export type ApiTestCustodyWallet = CustodyWallet;

export const apiTestSupport = {
  app,
  buildExternalWalletDepositTransaction,
  buildExternalWalletWithdrawalTransaction,
  closeAllRedisClients,
  closeDatabasePools,
  createKoraAdapter,
  createKVStoreSet,
  createMosaicService,
  createOrgSignerForCustodyWallet,
  createPostgresEarnRepository,
  createSigningService,
  createVaultDeadline,
  depositIntoVault,
  CustodyConfigStore,
  ensureTestClerkIssuer,
  DVP_SWAP_PROGRAM_PROGRAM_ADDRESS,
  EARN_PROVIDERS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getDb,
  hashString,
  KORA_ENV_KEYS,
  KoraAdapter,
  KoraClient,
  resolveEarnExecutionClient,
  resolveKoraEndpoint,
  runAsMoneyPrincipal,
  seedTestDatabase,
  signTestClerkJwt,
  submitExternalWalletDeposit,
  submitExternalWalletWithdrawal,
  supportsVaultDirect,
  TOKEN_PROGRAM_ADDRESS,
  SponsorshipBudgetRepository,
  TEST_ORG,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
  TEST_USER,
  trackPendingTransfers: (env: Env) => runInEachClusterScope(() => trackPendingTransfers(env)),
  withdrawFromVault,
};
