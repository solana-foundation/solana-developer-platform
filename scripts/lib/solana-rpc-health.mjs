// biome-ignore lint/security/noSecrets: JSON-RPC method name, not a secret.
const GET_LATEST_BLOCKHASH_METHOD = "getLatestBlockhash";

const PROVIDERS = [
  {
    id: "alchemy",
    urlKey: "SOLANA_RPC_ALCHEMY_URL",
    apiKey: "SOLANA_RPC_ALCHEMY_API_KEY",
  },
  {
    id: "quicknode",
    urlKey: "SOLANA_RPC_QUICKNODE_URL",
    apiKey: "SOLANA_RPC_QUICKNODE_API_KEY",
  },
  {
    id: "triton",
    urlKey: "SOLANA_RPC_TRITON_URL",
    apiKey: "SOLANA_RPC_TRITON_API_KEY",
  },
  {
    id: "default",
    urlKey: "SOLANA_RPC_URL",
  },
  {
    id: "helius",
    urlKey: "SOLANA_RPC_HELIUS_URL",
    apiKey: "SOLANA_RPC_HELIUS_API_KEY",
  },
];

export async function selectHealthySolanaRpcUrl(env, options = {}) {
  const candidates = getSolanaRpcCandidates(env);
  if (candidates.length === 0) {
    return undefined;
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      await assertSolanaRpcHealthy(candidate.url, options);
      return candidate;
    } catch (error) {
      failures.push(
        `${candidate.id} (${safeHostname(candidate.url)}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  throw new Error(`No healthy Solana RPC URL found. Checked: ${failures.join("; ")}`);
}

export function getSolanaRpcCandidates(env) {
  const seen = new Set();
  const preferred = env.SOLANA_RPC_CI_PREFERRED_PROVIDER;
  const providers = orderProviders(preferred);

  return providers.flatMap((provider) => {
    const rawUrl = env[provider.urlKey];
    if (!rawUrl) {
      return [];
    }

    const url = applyApiKeyTemplate(rawUrl, provider.apiKey ? env[provider.apiKey] : undefined);
    if (seen.has(url)) {
      return [];
    }

    seen.add(url);
    return [{ ...provider, url }];
  });
}

export function solanaRpcKeys() {
  return PROVIDERS.map((provider) => provider.urlKey);
}

export async function solanaJsonRpc(rpcUrl, method, params = [], options = {}) {
  const response = await fetchWithTimeout(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    options.timeoutMs ?? 10_000
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message ?? "unknown JSON-RPC error");
  }

  return payload.result;
}

export function safeHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid-url";
  }
}

function orderProviders(preferred) {
  if (!preferred) {
    return PROVIDERS;
  }

  const preferredProvider = PROVIDERS.find((provider) => provider.id === preferred);
  if (!preferredProvider) {
    return PROVIDERS;
  }

  return [preferredProvider, ...PROVIDERS.filter((provider) => provider.id !== preferred)];
}

async function assertSolanaRpcHealthy(rpcUrl, options) {
  const payload = await solanaJsonRpc(
    rpcUrl,
    GET_LATEST_BLOCKHASH_METHOD,
    [{ commitment: "confirmed" }],
    options
  );

  if (!payload?.value?.blockhash) {
    throw new Error("missing latest blockhash");
  }
}

function applyApiKeyTemplate(url, apiKey) {
  if (!apiKey) {
    return url;
  }

  if (url.includes("{API_KEY}")) {
    return url.replaceAll("{API_KEY}", apiKey);
  }

  return url;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
