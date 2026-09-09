import { getBase58Codec } from "@solana/codecs";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { z } from "zod";

const configSchema = z.object({
  SDP_API_BASE_URL: z.url().default("http://127.0.0.1:8787"),
  SDP_API_KEY: z.string().min(1, "SDP_API_KEY is required"),
  DEMO_WALLET_PRIVATE_KEY: z
    .string()
    .min(1, "DEMO_WALLET_PRIVATE_KEY is required"),
  SOLANA_RPC_URL: z.url().default("https://api.devnet.solana.com"),
  DEMO_API_PORT: z.coerce.number().int().min(1).max(65_535).default(4174),
});

export type DemoConfig = z.infer<typeof configSchema>;

let cachedConfig: DemoConfig | undefined;
let cachedSigner: KeyPairSigner | undefined;

export function getConfig(): DemoConfig {
  if (cachedConfig) return cachedConfig;

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new Error(`Invalid demo configuration: ${messages}`);
  }

  cachedConfig = result.data;
  return result.data;
}

export async function getDemoSigner(): Promise<KeyPairSigner> {
  if (cachedSigner) return cachedSigner;

  const bytes = decodePrivateKey(getConfig().DEMO_WALLET_PRIVATE_KEY);
  cachedSigner = await createKeyPairSignerFromBytes(bytes);
  return cachedSigner;
}

export function decodePrivateKey(value: string): Uint8Array {
  const trimmed = value.trim();
  let bytes: Uint8Array;

  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      !Array.isArray(parsed) ||
      parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) {
      throw new Error(
        "DEMO_WALLET_PRIVATE_KEY must be a JSON array of bytes or base58"
      );
    }
    bytes = Uint8Array.from(parsed);
  } else {
    bytes = Uint8Array.from(getBase58Codec().encode(trimmed));
  }

  if (bytes.length !== 64) {
    throw new Error(
      `DEMO_WALLET_PRIVATE_KEY must decode to 64 bytes; received ${bytes.length}`
    );
  }

  return bytes;
}
