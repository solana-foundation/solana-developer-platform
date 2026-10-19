import { apiTestSupport } from "@sdp/api/test-support";
import { resolveDefaultCluster } from "@sdp/rpc/config";
import { env } from "#env-impl";

const { resolveKoraEndpoint } = apiTestSupport;

/** The Kora this run targets: the `SOLANA_NETWORK` cluster's `KORA_<CLUSTER>_*` trio, or null. */
export const koraEndpoint = resolveKoraEndpoint(env, resolveDefaultCluster(env));

/** The env var that names {@link koraEndpoint}'s URL, for "missing" messages. */
export const KORA_URL_ENV_KEY =
  resolveDefaultCluster(env) === "mainnet-beta" ? "KORA_MAINNET_URL" : "KORA_DEVNET_URL";

/**
 * The Kora this run targets, for suites that cannot run without one.
 *
 * @returns The `SOLANA_NETWORK` cluster's Kora endpoint.
 * @throws When that cluster has no `KORA_<CLUSTER>_URL`.
 */
export function requireKoraEndpoint(): NonNullable<typeof koraEndpoint> {
  if (koraEndpoint === null) {
    throw new Error(`${KORA_URL_ENV_KEY} is required for the Kora integration suites.`);
  }
  return koraEndpoint;
}
