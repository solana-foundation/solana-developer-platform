import type { OrganizationRpcProvider } from "@sdp/types";
import type { RpcEnv } from "./types";

export interface SolanaConfig {
  rpcUrl: string;
  network: "devnet" | "mainnet-beta";
}

const API_KEY_TEMPLATE = ["$", "{API_KEY}"].join("");

export function applyApiKeyTemplate(url: string, apiKey: string): string {
  return url
    .replaceAll(API_KEY_TEMPLATE, encodeURIComponent(apiKey))
    .replaceAll("{API_KEY}", encodeURIComponent(apiKey));
}

function appendQueryParam(url: string, key: string, value: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function withHeliusApiKey(url: string, apiKey?: string): string {
  if (!apiKey) {
    return url;
  }

  const templated = applyApiKeyTemplate(url, apiKey);
  if (templated !== url) {
    return templated;
  }

  return appendQueryParam(url, "api-key", apiKey);
}

export function withAlchemyApiKey(url: string, apiKey?: string): string {
  if (!apiKey) {
    return url;
  }

  const templated = applyApiKeyTemplate(url, apiKey);
  if (templated !== url) {
    return templated;
  }

  if (url.endsWith("/v2")) {
    return `${url}/${encodeURIComponent(apiKey)}`;
  }
  if (url.endsWith("/v2/")) {
    return `${url}${encodeURIComponent(apiKey)}`;
  }

  return appendQueryParam(url, "api_key", apiKey);
}

export function withOptionalApiKeyTemplate(url: string, apiKey?: string): string {
  if (!apiKey) {
    return url;
  }

  return applyApiKeyTemplate(url, apiKey);
}

type ManagedRpcProvider = {
  id: OrganizationRpcProvider;
  url: string;
};

function buildManagedRpcProviders(env: RpcEnv): ManagedRpcProvider[] {
  const providers: ManagedRpcProvider[] = [];

  if (env.SOLANA_RPC_TRITON_URL) {
    providers.push({
      id: "triton",
      url: applyApiKeyTemplate(env.SOLANA_RPC_TRITON_URL, env.SOLANA_RPC_TRITON_API_KEY ?? ""),
    });
  }

  if (env.SOLANA_RPC_HELIUS_URL) {
    providers.push({
      id: "helius",
      url: withHeliusApiKey(env.SOLANA_RPC_HELIUS_URL, env.SOLANA_RPC_HELIUS_API_KEY),
    });
  }

  if (env.SOLANA_RPC_ALCHEMY_URL) {
    providers.push({
      id: "alchemy",
      url: withAlchemyApiKey(env.SOLANA_RPC_ALCHEMY_URL, env.SOLANA_RPC_ALCHEMY_API_KEY),
    });
  }

  if (env.SOLANA_RPC_QUICKNODE_URL) {
    providers.push({
      id: "quicknode",
      url: withOptionalApiKeyTemplate(
        env.SOLANA_RPC_QUICKNODE_URL,
        env.SOLANA_RPC_QUICKNODE_API_KEY
      ),
    });
  }

  if (env.SOLANA_RPC_VALIDATIONCLOUD_URL) {
    providers.push({
      id: "validationcloud",
      url: applyApiKeyTemplate(
        env.SOLANA_RPC_VALIDATIONCLOUD_URL,
        env.SOLANA_RPC_VALIDATIONCLOUD_API_KEY ?? ""
      ),
    });
  }

  if (env.SOLANA_RPC_NODIT_URL) {
    providers.push({
      id: "nodit",
      url: withOptionalApiKeyTemplate(env.SOLANA_RPC_NODIT_URL, env.SOLANA_RPC_NODIT_API_KEY),
    });
  }

  if (env.SOLANA_RPC_URL) {
    providers.push({
      id: "default",
      url: env.SOLANA_RPC_URL,
    });
  }

  return providers;
}

export function resolveSolanaRpcProviderUrls(env: RpcEnv): string[] {
  const providers = buildManagedRpcProviders(env);
  const preferred = env.SOLANA_RPC_DEFAULT_PROVIDER
    ? providers.find((provider) => provider.id === env.SOLANA_RPC_DEFAULT_PROVIDER)
    : undefined;
  const ordered = preferred
    ? [preferred, ...providers.filter((provider) => provider !== preferred)]
    : providers;
  return [...new Set(ordered.map((provider) => provider.url))];
}

/** The cluster this process's single-cluster configuration (`SOLANA_NETWORK`) serves. */
export function resolveDefaultCluster(
  env: Pick<RpcEnv, "SOLANA_NETWORK">
): "devnet" | "mainnet-beta" {
  return env.SOLANA_NETWORK ?? "devnet";
}

export function resolveDefaultSolanaRpcUrl(env: RpcEnv): string | null {
  return resolveSolanaRpcProviderUrls(env)[0] ?? null;
}

export function getSolanaConfig(env: RpcEnv): SolanaConfig {
  const rpcUrl = resolveDefaultSolanaRpcUrl(env);
  const network = resolveDefaultCluster(env);

  if (!rpcUrl) {
    throw new Error("No Solana RPC endpoint is configured");
  }

  return { rpcUrl, network };
}

/**
 * The RPC endpoint for `cluster`, on a process that may serve BOTH clusters at
 * once (a sandbox project is devnet, a production project is mainnet-beta).
 *
 * `SOLANA_DEVNET_RPC_URL` / `SOLANA_MAINNET_RPC_URL` are explicit overrides and
 * always win. Without one, the canonical default (`resolveDefaultSolanaRpcUrl`,
 * with its managed-provider selection and key expansion) is safe ONLY for the
 * cluster the process names in `SOLANA_NETWORK`; the other cluster answers `""`
 * so callers fail closed instead of building against the wrong chain.
 */
export function resolveClusterRpcUrl(env: RpcEnv, cluster: "devnet" | "mainnet-beta"): string {
  const perCluster = cluster === "devnet" ? env.SOLANA_DEVNET_RPC_URL : env.SOLANA_MAINNET_RPC_URL;
  if (typeof perCluster === "string" && perCluster.trim() !== "") return perCluster.trim();

  if (resolveDefaultCluster(env) !== cluster) return "";
  return resolveDefaultSolanaRpcUrl(env)?.trim() ?? "";
}
