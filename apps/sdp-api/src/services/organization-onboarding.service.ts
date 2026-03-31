import {
  provisionCoinbaseCdpAccount,
  provisionFireblocksVaultAccount,
  provisionParaWallet,
  provisionTurnkeyPrivateKey,
} from "@/services/custody/provisioning";
import { createSigningService } from "@/services/domain/signing.service";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import type { OrganizationCustodyRequest } from "@sdp/types";
import { getDb } from "@/db";

export class OrganizationOnboardingService {
  constructor(private readonly env: Env) {}

  async initializeCustody(
    orgId: string,
    orgSlug: string,
    custody: OrganizationCustodyRequest
  ): Promise<void> {
    const signingService = createSigningService(this.env);

    try {
      switch (custody.provider) {
        case "fireblocks": {
          const { vaultAccountId, assetId } = await provisionFireblocksVaultAccount(this.env, {
            orgId,
            orgSlug,
          });

          if (!this.env.FIREBLOCKS_API_KEY || !this.env.FIREBLOCKS_API_SECRET) {
            throw new SigningError(
              "Fireblocks environment variables not configured: FIREBLOCKS_API_KEY, FIREBLOCKS_API_SECRET",
              "PROVIDER_NOT_CONFIGURED"
            );
          }

          await signingService.initializeFireblocksSigning(orgId, undefined, {
            apiKey: this.env.FIREBLOCKS_API_KEY,
            apiSecretPem: this.env.FIREBLOCKS_API_SECRET,
            vaultAccountId,
            assetId,
            apiBaseUrl: this.env.FIREBLOCKS_API_BASE_URL,
          });
          return;
        }
        case "coinbase_cdp": {
          const provisioned = await provisionCoinbaseCdpAccount(this.env, {
            orgId,
            orgSlug,
            apiBaseUrl: custody.apiBaseUrl,
            network: custody.network,
            walletAddress: custody.walletAddress,
            accountPolicy: custody.accountPolicy,
          });

          await signingService.initializeCoinbaseCdpSigning(orgId, undefined, {
            apiBaseUrl: custody.apiBaseUrl ?? this.env.COINBASE_CDP_API_BASE_URL,
            network: custody.network ?? this.env.COINBASE_CDP_NETWORK,
            walletAddress: provisioned.address,
            accountPolicy: custody.accountPolicy,
          });
          return;
        }
        case "para": {
          const provisioned = await provisionParaWallet(this.env, {
            orgId,
            orgSlug,
            apiBaseUrl: custody.apiBaseUrl,
            walletId: custody.walletId,
          });

          await signingService.initializeParaSigning(orgId, undefined, {
            apiBaseUrl: custody.apiBaseUrl ?? this.env.PARA_API_BASE_URL,
            requestDelayMs: custody.requestDelayMs,
            walletId: provisioned.walletId,
          });
          return;
        }
        case "turnkey": {
          const provisioned = await provisionTurnkeyPrivateKey(this.env, {
            orgId,
            orgSlug,
            apiBaseUrl: custody.apiBaseUrl,
            privateKeyId: custody.privateKeyId,
          });

          await signingService.initializeTurnkeySigning(orgId, undefined, {
            apiBaseUrl: custody.apiBaseUrl ?? this.env.TURNKEY_API_BASE_URL,
            requestDelayMs: custody.requestDelayMs,
            privateKeyId: provisioned.privateKeyId,
          });
          return;
        }
        case "dfns":
          await signingService.initializeDfnsSigning(orgId, undefined, {
            apiBaseUrl: custody.apiBaseUrl ?? this.env.DFNS_API_BASE_URL,
            network: custody.network,
            walletId: custody.walletId,
            signingKeyId: custody.signingKeyId,
          });
          return;
        case "anchorage":
          await signingService.initializeAnchorageWalletLifecycle(orgId, undefined, {
            apiBaseUrl: custody.apiBaseUrl ?? this.env.ANCHORAGE_API_BASE_URL,
            walletId: custody.walletId,
            network: custody.network,
          });
          return;
        case "privy":
          await signingService.initializePrivySigning(orgId, undefined, {
            apiBaseUrl: custody.apiBaseUrl ?? this.env.PRIVY_API_BASE_URL,
            requestDelayMs: custody.requestDelayMs,
          });
          return;
      }
    } catch (error) {
      await this.cleanupCustody(orgId);
      throw error;
    }
  }

  async cleanupCustody(orgId: string): Promise<void> {
    await getDb(this.env).batch([
      getDb(this.env).prepare(
        `DELETE FROM custody_wallets
         WHERE custody_config_id IN (
           SELECT id FROM custody_configs WHERE organization_id = ?
         )`
      ).bind(orgId),
      getDb(this.env).prepare("DELETE FROM custody_configs WHERE organization_id = ?").bind(orgId),
    ]);
  }
}

export function createOrganizationOnboardingService(env: Env): OrganizationOnboardingService {
  return new OrganizationOnboardingService(env);
}
