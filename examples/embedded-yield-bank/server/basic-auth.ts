import "server-only";

import { timingSafeEqual } from "node:crypto";

export interface AccessCredentials {
  username: string;
  password: string;
}

export function getAccessCredentials(
  environment: Record<string, string | undefined> = process.env
): AccessCredentials | undefined {
  const password = environment.DEMO_ACCESS_PASSWORD;
  if (!password) return undefined;

  const username = environment.DEMO_ACCESS_USERNAME?.trim() || "northstar";
  if (username.includes(":")) {
    throw new Error("DEMO_ACCESS_USERNAME cannot contain a colon");
  }

  return { username, password };
}

export function hasValidBasicAuthorization(
  authorization: string | null,
  expected: AccessCredentials
): boolean {
  const encoded = authorization?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!encoded) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return false;

  return (
    safeEqual(decoded.slice(0, separator), expected.username) &&
    safeEqual(decoded.slice(separator + 1), expected.password)
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
