export interface SafeRingsConnection {
  id: string;
  name: string;
  network: "devnet";
  status: "active" | "failed" | "deactivated";
  isDefault: boolean;
  allowInsecureHttp: boolean;
  endpoints: {
    rpc: string | null;
    indexer: string | null;
    prover: string | null;
    ringRpc: string | null;
  };
}

export interface RingsSetupStatus {
  configured: boolean;
  source: "database" | "none";
  canManage: boolean;
  allowInsecureHttpAllowed: boolean;
  defaultConnection: SafeRingsConnection | null;
}

interface Envelope<T> {
  data?: T;
  error?: { message?: string };
}

async function read<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as Envelope<T>;
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? fallback);
  return body.data;
}

export async function fetchRingsSetupStatus(): Promise<RingsSetupStatus> {
  const response = await fetch("/api/dashboard/helius-rings/setup-status", { cache: "no-store" });
  return read(response, "Could not load the Helius Rings configuration");
}

export async function createRingsConnection(input: {
  name: string;
  solanaRpcUrl: string;
  indexerUrl: string;
  proverUrl: string;
  ringRpcUrl?: string;
  allowInsecureHttp: boolean;
}): Promise<SafeRingsConnection> {
  const response = await fetch("/api/dashboard/helius-rings/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return read(response, "Could not save the Helius Rings configuration");
}
