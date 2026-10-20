import { resolveDefaultCluster } from "@sdp/rpc/config";
import { env } from "#env-impl";

/** The run's cluster's `KORA_<CLUSTER>` prefix: the harness sponsors on `SOLANA_NETWORK`'s cluster. */
const KORA_ENV_PREFIX =
  resolveDefaultCluster(env) === "mainnet-beta" ? "KORA_MAINNET" : "KORA_DEVNET";

/** The env var that names {@link koraEndpoint}'s URL, for "missing" messages. */
export const KORA_URL_ENV_KEY = `${KORA_ENV_PREFIX}_URL` as const;

const koraUrl = env[KORA_URL_ENV_KEY]?.trim();

/**
 * The Kora this run targets: the `SOLANA_NETWORK` cluster's `KORA_<CLUSTER>_*` trio, or null.
 * Read from env rather than `resolveKoraEndpoint`, which needs a cluster scope that helpers
 * never open.
 */
export const koraEndpoint = koraUrl
  ? {
      rpcUrl: koraUrl,
      apiKey: env[`${KORA_ENV_PREFIX}_API_KEY`],
      identityTokenAudience: env[`${KORA_ENV_PREFIX}_CLOUD_RUN_AUDIENCE`],
    }
  : null;

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
