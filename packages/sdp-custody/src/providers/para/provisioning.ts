import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { SigningError } from "#/signing";
import {
  buildParaUserIdentifier,
  type ParaWalletResponse,
  paraRequest,
  validateParaWallet,
  waitForParaWalletReady,
} from "./api";

export interface ProvisionParaOptions {
  orgId: string;
  orgSlug: string;
  projectId?: string;
}

export interface ParaProvisioningConfig {
  cluster: SolanaCluster;
  apiKey?: string;
}

export interface ProvisionParaResult {
  walletId: string;
  address: string;
  userIdentifier: string;
  userIdentifierType: "CUSTOM_ID";
}

export async function provisionParaWallet(
  runtime: CustodyProvisioningRuntime,
  config: ParaProvisioningConfig,
  options: ProvisionParaOptions
): Promise<ProvisionParaResult> {
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new SigningError(
      "Para environment variables not configured: PARA_API_KEY",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const userIdentifier = buildParaUserIdentifier({
    orgId: options.orgId,
    projectId: options.projectId,
  });
  const created = await paraRequest<ParaWalletResponse>(runtime, {
    cluster: config.cluster,
    apiKey,
    method: "POST",
    path: "/v1/wallets",
    body: {
      type: "SOLANA",
      scheme: "ED25519",
      userIdentifier,
      userIdentifierType: "CUSTOM_ID",
    },
  });

  if (!created?.id) {
    throw new SigningError("Para wallet creation failed", "PROVIDER_NOT_CONFIGURED");
  }

  const readyWallet = await waitForParaWalletReady(runtime, {
    cluster: config.cluster,
    apiKey,
    walletId: created.id,
  });
  const validated = validateParaWallet(readyWallet, created.id);

  return {
    walletId: validated.id,
    address: validated.address,
    userIdentifier,
    userIdentifierType: "CUSTOM_ID",
  };
}
