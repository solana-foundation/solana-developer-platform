import { apiTestSupport } from "@sdp/api/test-support";
import { resolveDefaultCluster } from "@sdp/rpc/config";
import { env } from "#env-impl";

const { KORA_ENV_KEYS } = apiTestSupport;

/** The run's cluster's Kora env keys: the harness sponsors on `SOLANA_NETWORK`'s cluster. */
const koraEnvKeys = KORA_ENV_KEYS[resolveDefaultCluster(env)];

/** The env var that names {@link koraEndpoint}'s URL, for "missing" messages. */
export const KORA_URL_ENV_KEY = koraEnvKeys.serviceUrl;

const koraUrl = env[koraEnvKeys.serviceUrl]?.trim();

/**
 * The Kora this run targets: the `SOLANA_NETWORK` cluster's `KORA_<CLUSTER>_*` trio, or null.
 * Read from env rather than `resolveKoraEndpoint`, which needs a cluster scope that helpers
 * never open.
 */
export const koraEndpoint = koraUrl
  ? {
      rpcUrl: koraUrl,
      apiKey: env[koraEnvKeys.apiKey],
      identityTokenAudience: env[koraEnvKeys.identityTokenAudience],
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
