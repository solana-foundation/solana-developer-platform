import { Buffer } from "node:buffer";
import { redactCredentialString } from "@/lib/redaction";
import { SigningError } from "@/services/ports";

function hasEmptyResponseBody(response: Response): boolean {
  return response.status === 204 || response.headers.get("content-length") === "0";
}

export async function readErrorResponseText(response: Response): Promise<string> {
  return response
    .text()
    .then((body) => redactCredentialString(body))
    .catch(() => "Failed to read error response");
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (hasEmptyResponseBody(response)) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function sortJsonKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortJsonKeys(item));
  }

  if (typeof value !== "object") {
    return value;
  }

  const objectValue = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(objectValue).sort()) {
    result[key] = sortJsonKeys(objectValue[key]);
  }
  return result;
}

export function toBase64Url(bytes: Uint8Array): string {
  return encodeBase64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64ToBytes(value: string): Uint8Array {
  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: string, encoding: "base64") => Uint8Array;
    };
  };

  if (globalWithBuffer.Buffer) {
    return new Uint8Array(globalWithBuffer.Buffer.from(value, "base64"));
  }

  if (typeof atob !== "function") {
    throw new SigningError("Unable to decode base64 secret", "PROVIDER_NOT_CONFIGURED");
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeBase64FromBytes(bytes: Uint8Array): string {
  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: Uint8Array) => { toString: (encoding: "base64") => string };
    };
  };

  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  if (typeof btoa !== "function") {
    throw new SigningError("Unable to encode base64 payload", "PROVIDER_NOT_CONFIGURED");
  }

  return btoa(binary);
}

export function encodePkcs8Pem(privateKeyDer: Uint8Array): string {
  const base64 = encodeBase64FromBytes(privateKeyDer);
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

export function normalizePem(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}

export function encodeBasicAuth(value: string): string {
  if (typeof btoa === "function") {
    return btoa(value);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf-8").toString("base64");
  }

  throw new SigningError("Unable to encode Basic auth header", "PROVIDER_NOT_CONFIGURED");
}
