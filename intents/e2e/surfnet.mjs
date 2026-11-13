// What the e2e run and the playground setup share: the surfnet's RPC, keypair files, the CLI, and
// the mainnet addresses that the flows use.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CLI = new URL("../target/debug/sdp-intents", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSTEM = "11111111111111111111111111111111";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const JUPITER_USDT_VAULT = "F7tLdeF2YZZex9MR8HgGggyFiz7UU2UgUube2tmfwNPE";
export const JUPITER_SHARES = "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A";
export const KAMINO_USDC_VAULT = "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E";
/// The registry address of the organization `solana.org`.
export const ORGANIZATION = "8Zth9xaiuwMGKHhdh3hWbFHSE8fhwseKnTKUa75VAEnp";

export function base58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let text = "";
  for (; value > 0n; value /= 58n) text = ALPHABET[Number(value % 58n)] + text;

  const zeros = bytes.findIndex((byte) => byte !== 0);
  return "1".repeat(zeros === -1 ? bytes.length : zeros) + text;
}

/// A JSON-RPC client of `url`, which throws on an error answer.
export function rpcClient(url) {
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const { result, error } = await response.json();

    if (error) throw new Error(`${method}: ${JSON.stringify(error)}`);

    return result;
  };
}

/// A keypair file in the Solana CLI's format: the 32-byte secret, then the 32-byte public key. With
/// `keep`, an existing file stays, so its address does not change between runs.
export function keypair(folder, name, { keep = false } = {}) {
  const path = `${folder}${name}.json`;

  if (keep && existsSync(path)) {
    return { path, address: base58(JSON.parse(readFileSync(path, "utf8")).slice(32)) };
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  writeFileSync(path, JSON.stringify([...secret, ...pub]));

  return { path, address: base58(pub) };
}

export function cli(...args) {
  return execFileSync(CLI, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
