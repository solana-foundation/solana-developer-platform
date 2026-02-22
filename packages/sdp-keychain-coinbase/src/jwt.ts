import { getBase64Decoder, getBase64Encoder } from "@solana/codecs-strings";
import { SignerErrorCode, throwSignerError } from "@solana/keychain-core";
import { SignJWT, importJWK, importPKCS8 } from "jose";
import { isPemEncodedKey, randomHex, sortJsonKeys } from "./utils.js";

interface CoinbaseCdpBearerJwtParams {
  apiKeyId: string;
  apiKeySecret: string;
  requestHost: string;
  requestMethod: string;
  requestPath: string;
}

export async function createCoinbaseCdpBearerJwt(
  params: CoinbaseCdpBearerJwtParams
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomHex(16);
  const uri = `${params.requestMethod} ${params.requestHost}${params.requestPath}`;
  const payload = new SignJWT({ uris: [uri] })
    .setIssuer("cdp")
    .setSubject(params.apiKeyId)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 120);

  if (isPemEncodedKey(params.apiKeySecret)) {
    const key = await importPKCS8(params.apiKeySecret, "ES256");
    return payload.setProtectedHeader({ alg: "ES256", kid: params.apiKeyId, nonce }).sign(key);
  }

  let rawKey: Uint8Array;
  try {
    rawKey = new Uint8Array(getBase64Encoder().encode(params.apiKeySecret));
  } catch (error) {
    throwSignerError(SignerErrorCode.CONFIG_ERROR, {
      cause: error,
      message: "Unable to decode base64 API key secret",
    });
  }
  if (rawKey.length !== 64) {
    throwSignerError(SignerErrorCode.CONFIG_ERROR, {
      message:
        "COINBASE_CDP_API_KEY_SECRET has invalid format. Expected EC PEM or base64 Ed25519 private key bytes.",
    });
  }

  const seed = rawKey.slice(0, 32);
  const publicKey = rawKey.slice(32);
  const key = await importJWK(
    {
      crv: "Ed25519",
      d: toBase64Url(seed),
      kty: "OKP",
      x: toBase64Url(publicKey),
    },
    "EdDSA"
  );

  return payload.setProtectedHeader({ alg: "EdDSA", kid: params.apiKeyId, nonce }).sign(key);
}

interface CoinbaseCdpWalletJwtParams {
  requestData: Record<string, unknown>;
  requestHost: string;
  requestMethod: string;
  requestPath: string;
  walletSecret: string;
}

export async function createCoinbaseCdpWalletJwt(
  params: CoinbaseCdpWalletJwtParams
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const uri = `${params.requestMethod} ${params.requestHost}${params.requestPath}`;
  const payload: Record<string, unknown> = { uris: [uri] };
  const hasRequestData =
    Object.keys(params.requestData).length > 0 &&
    Object.values(params.requestData).some((value) => value !== undefined);

  if (hasRequestData) {
    payload.reqHash = await sha256Hex(JSON.stringify(sortJsonKeys(params.requestData)));
  }

  let privateKeyDer: Uint8Array;
  try {
    privateKeyDer = new Uint8Array(getBase64Encoder().encode(params.walletSecret));
  } catch (error) {
    throwSignerError(SignerErrorCode.CONFIG_ERROR, {
      cause: error,
      message: "Unable to decode base64 wallet secret",
    });
  }
  const privateKeyPem = encodePkcs8Pem(privateKeyDer);
  const key = await importPKCS8(privateKeyPem, "ES256");

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setJti(randomHex(16))
    .sign(key);
}

function toBase64Url(bytes: Uint8Array): string {
  return getBase64Decoder()
    .decode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodePkcs8Pem(privateKeyDer: Uint8Array): string {
  const base64 = getBase64Decoder().decode(privateKeyDer);
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
