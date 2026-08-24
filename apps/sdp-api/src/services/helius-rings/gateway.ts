import {
  HeliusRingsError,
  NotImplementedRingsGateway,
  type RingsGatewayPort,
  type RuntimeHealth,
} from "@sdp/helius-rings";
import { createRingsGateway } from "@sdp/helius-rings-sdk";
import { withHeliusApiKey } from "@sdp/rpc/relay";
import { isRingsInsecureHttpAllowed } from "@/lib/feature-flags";
import type { Env } from "@/types/env";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsOuterTransaction } from "./signer-adapter";

/**
 * Chooses the gateway the Rings service talks to.
 *
 * This is the only place `@sdp/helius-rings-sdk` is reached from, and it is
 * deliberately narrow: the SDK package is pinned to `@solana/kit` 7 while the
 * rest of this app is on 6, so everything crossing this function is a plain
 * string or a type from the Kit-free `@sdp/helius-rings`.
 */

/** Selects the in-process TypeScript gateway. Anything else runs unimplemented. */
const TS_ADAPTER = "ts";

const ALL_RED: RuntimeHealth = { rpc: "red", photon: "red", prover: "red", gateway: "red" };

/**
 * Stands in when the TypeScript adapter is selected but not fully configured.
 *
 * It neither throws at construction nor quietly downgrades to the
 * not-implemented gateway. Throwing would turn every Rings request into a 500,
 * including the health probe an operator would use to diagnose it, and
 * downgrading would hide the mistake behind a plausible-looking response. So
 * health reports red with the reason, and anything that would move money fails
 * closed with `config_error`.
 */
function misconfiguredGateway(missing: readonly string[]): RingsGatewayPort {
  const reason = `missing ${missing.join(", ")}`;
  const fail = async (): Promise<never> => {
    throw new HeliusRingsError(
      "config_error",
      `Rings TypeScript gateway is misconfigured: ${reason}`
    );
  };

  return {
    probeHealth: async () => ({ ...ALL_RED, detail: { gateway: reason } }),
    provisionIdentity: fail,
    syncPhoton: fail,
    buildOperation: fail,
    requestProof: fail,
    verifyIndexed: fail,
  };
}

/**
 * The placeholder `SOLANA_RPC_HELIUS_URL` carries until an API key replaces it.
 * `withHeliusApiKey` returns the URL untouched when the key is absent, so a
 * surviving placeholder is how a missing key becomes visible — otherwise the
 * client is built against a literal `{API_KEY}` and the only symptom is an
 * unreachable RPC, which points at the wrong variable.
 */
const API_KEY_PLACEHOLDER = "{API_KEY}";

/**
 * The tenant a gateway answers for. Fixed at construction because key material
 * is derived per organization and project: passing the triple on every call
 * would make deriving under the wrong tenant a matter of argument discipline
 * rather than something the type system prevents.
 */
export interface RingsGatewayTenant {
  organizationId: string;
  projectId: string;
}

export function resolveRingsGateway(env: Env, tenant: RingsGatewayTenant): RingsGatewayPort {
  if (env.HELIUS_RINGS_ADAPTER !== TS_ADAPTER) {
    return new NotImplementedRingsGateway();
  }

  // Rings needs a Helius endpoint specifically — Photon and the prover are
  // Helius services — so this does not fall back to SOLANA_RPC_URL.
  const rpcUrl = env.SOLANA_RPC_HELIUS_URL;
  const indexerUrl = env.HELIUS_RINGS_INDEXER_URL;
  const proverUrl = env.HELIUS_RINGS_PROVER_URL;
  const solanaRpcUrl = rpcUrl ? withHeliusApiKey(rpcUrl, env.SOLANA_RPC_HELIUS_API_KEY) : undefined;

  const derivationSeed = env.HELIUS_RINGS_DETERMINISTIC_KA_SEED;

  const missing = [
    ["SOLANA_RPC_HELIUS_URL", rpcUrl],
    ["HELIUS_RINGS_INDEXER_URL", indexerUrl],
    ["HELIUS_RINGS_PROVER_URL", proverUrl],
    ["HELIUS_RINGS_DETERMINISTIC_KA_SEED", derivationSeed],
    [
      "SOLANA_RPC_HELIUS_API_KEY",
      solanaRpcUrl?.includes(API_KEY_PLACEHOLDER) ? undefined : solanaRpcUrl,
    ],
  ].flatMap(([name, value]) => (value ? [] : [name as string]));

  if (missing.length > 0 || !(solanaRpcUrl && indexerUrl && proverUrl)) {
    return misconfiguredGateway(missing);
  }

  return createRingsGateway({
    solanaRpcUrl,
    indexerUrl,
    proverUrl,
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    derivationSeed,
    // Custody keeps the owner's Ed25519 secret, so the gateway orchestrates
    // registration but hands the bytes back here to be signed and broadcast.
    signTransaction: (unsignedTxBase64, owner) =>
      signRingsOuterTransaction({
        env,
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        owner,
        unsignedTxBase64,
      }),
    submitTransaction: (signedTxBase64) => submitRingsOuterTransaction({ env, signedTxBase64 }),
    allowInsecureHttp: isRingsInsecureHttpAllowed(env),
  });
}
