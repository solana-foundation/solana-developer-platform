/**
 * IBM Digital Asset Haven Signing Adapter
 *
 * IBM Digital Asset Haven is a white-label deployment of the Dfns WaaS API, so it
 * reuses the entire Dfns signing stack (client, DfnsSigner, signature polling).
 * Two things differ from the Dfns adapter:
 *  - providerId surfaces as "ibm_haven" and providerLabel as "IBM Digital Asset
 *    Haven" (telemetry / availability / UI / error messages).
 *  - wallet ids are stored with an `ibmhaven_` prefix; the reused DfnsSigner only
 *    strips `dfns_`, so per-call ids are denormalized to the raw `wa-…` id here
 *    before delegating, keeping the Dfns signer Haven-agnostic. The no-argument /
 *    sign() path relies on config.defaultWalletId, which the adapter factories
 *    already store denormalized (raw).
 */

import type { Address } from "@solana/kit";
import { IBM_HAVEN_PROVIDER_LABEL } from "../dfns/client";
import type { DfnsSigner } from "../dfns/signer";
import { denormalizeIbmHavenWalletId } from "../provider-wallet-ids";
import { KeychainDfnsAdapter } from "./keychain-dfns.adapter";

export class KeychainIbmHavenAdapter extends KeychainDfnsAdapter {
  override readonly providerId = "ibm_haven";

  protected override readonly providerLabel = IBM_HAVEN_PROVIDER_LABEL;

  override getTransactionSigner(walletId?: string, walletPublicKey?: Address): Promise<DfnsSigner> {
    return super.getTransactionSigner(toRawHavenWalletId(walletId), walletPublicKey);
  }

  override getPublicKey(walletId?: string): Promise<Address> {
    return super.getPublicKey(toRawHavenWalletId(walletId));
  }
}

function toRawHavenWalletId(walletId?: string): string | undefined {
  return walletId ? denormalizeIbmHavenWalletId(walletId) : undefined;
}
