import "server-only";

import { getBase58Codec } from "@solana/codecs";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { z } from "zod";

const configSchema = z.object({
  SDP_API_BASE_URL: z
    .url()
    .default("http://127.0.0.1:8787")
    .refine(
      allowsCleartext,
      "must use https unless it points at localhost; the API key and every built transaction cross this connection"
    ),
  SDP_API_KEY: z.string().min(1, "SDP_API_KEY is required"),
  DEMO_WALLET_PRIVATE_KEY: z
    .string()
    .min(1, "DEMO_WALLET_PRIVATE_KEY is required"),
  DEMO_FEE_PAYER_PRIVATE_KEY: z.string().min(1).optional(),
  DEMO_STRATEGY_ID: z.string().min(1).optional(),
  SOLANA_CLUSTER: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  SOLANA_RPC_URL: z.url().default("https://api.devnet.solana.com"),
});

/**
 * Loopback connections may stay cleartext for local development. Anything
 * else carries the SDP API key and the unsigned transactions the demo signs
 * with real keys, so it must be https — a MITM on this URL is a signing
 * oracle for both demo wallets.
 */
function allowsCleartext(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    ["localhost", "127.0.0.1"].includes(url.hostname)
  );
}

export type DemoConfig = z.infer<typeof configSchema>;

/** Exposed for tests; `getConfig` is the runtime entry point. */
export const demoConfigSchema = configSchema;

let cachedConfig: DemoConfig | undefined;
let cachedSigner: KeyPairSigner | undefined;
let cachedFeePayerSigner: KeyPairSigner | null | undefined;

export function getConfig(): DemoConfig {
  if (cachedConfig) return cachedConfig;

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid demo configuration: ${messages}`);
  }

  cachedConfig = result.data;
  return result.data;
}

export async function getDemoSigner(): Promise<KeyPairSigner> {
  if (cachedSigner) return cachedSigner;

  const bytes = decodePrivateKey(
    getConfig().DEMO_WALLET_PRIVATE_KEY,
    "DEMO_WALLET_PRIVATE_KEY"
  );
  cachedSigner = await createKeyPairSignerFromBytes(bytes);
  return cachedSigner;
}

export async function getFeePayerSigner(): Promise<KeyPairSigner | undefined> {
  if (cachedFeePayerSigner !== undefined)
    return cachedFeePayerSigner ?? undefined;

  const privateKey = getConfig().DEMO_FEE_PAYER_PRIVATE_KEY;
  if (!privateKey) {
    cachedFeePayerSigner = null;
    return undefined;
  }

  const bytes = decodePrivateKey(privateKey, "DEMO_FEE_PAYER_PRIVATE_KEY");
  cachedFeePayerSigner = await createKeyPairSignerFromBytes(bytes);
  return cachedFeePayerSigner;
}

export function decodePrivateKey(
  value: string,
  variableName = "DEMO_WALLET_PRIVATE_KEY"
): Uint8Array {
  const trimmed = value.trim();
  let bytes: Uint8Array;

  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      !Array.isArray(parsed) ||
      parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) {
      throw new Error(
        `${variableName} must be a JSON array of bytes or base58`
      );
    }
    bytes = Uint8Array.from(parsed);
  } else {
    bytes = Uint8Array.from(getBase58Codec().encode(trimmed));
  }

  if (bytes.length !== 64) {
    throw new Error(
      `${variableName} must decode to 64 bytes; received ${bytes.length}`
    );
  }

  return bytes;
}
