import fs from "node:fs";
import path from "node:path";

const DEFAULT_CLERK_TEST_ORG_NAME = "Solana";
const DEFAULT_CLERK_TEST_EMAIL = "e2e-smoke+sdp-web@example.com";
const BASE_URL = "http://localhost:3100";

type E2EEnv = {
  baseURL: string;
  clerkSecretKey: string;
  clerkPublishableKey: string;
  clerkJwtTemplate: string;
  clerkOrgId: string | null;
  clerkOrgName: string;
  clerkTestEmail: string;
  sdpApiBaseUrl: string;
  webServerEnv: Record<string, string>;
};

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const entries: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function getFallbackEnv(): Record<string, string> {
  const repoRoot = path.resolve(__dirname, "..");
  const local = parseEnvFile(path.join(repoRoot, ".env.local"));
  const preview = parseEnvFile(path.join(repoRoot, ".env.preview"));

  return {
    ...local,
    ...preview,
  };
}

function resolveEnvValue(
  name: string,
  fallback: Record<string, string>,
  defaultValue?: string
): string {
  const value = process.env[name] ?? fallback[name] ?? defaultValue;
  if (!value) {
    throw new Error(
      `Missing required E2E environment variable: ${name}. Run the command under \`doppler run\`, or provide the value via process env. apps/sdp-web/.env.local remains available only as a local fallback.`
    );
  }
  return value;
}

function resolveOptionalEnvValue(name: string, fallback: Record<string, string>): string | null {
  const value = process.env[name] ?? fallback[name];
  return value?.trim() ? value : null;
}

let cachedEnv: E2EEnv | null = null;

export function getE2EEnv(): E2EEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const fallback = getFallbackEnv();

  const clerkSecretKey = resolveEnvValue("CLERK_SECRET_KEY", fallback);
  const clerkPublishableKey = resolveEnvValue("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", fallback);
  const clerkJwtTemplate = resolveEnvValue("CLERK_JWT_TEMPLATE", fallback, "sdp-api");
  const sdpApiBaseUrl = resolveEnvValue(
    "SDP_API_BASE_URL",
    {
      ...fallback,
      SDP_API_BASE_URL:
        fallback.SDP_API_BASE_URL ||
        fallback.NEXT_PUBLIC_SDP_API_BASE_URL ||
        fallback.NEXT_PUBLIC_API_BASE_URL,
    },
    "https://sdp-api-dev.solana.workers.dev"
  );
  const publicApiBaseUrl =
    process.env.NEXT_PUBLIC_SDP_API_BASE_URL ??
    fallback.NEXT_PUBLIC_SDP_API_BASE_URL ??
    sdpApiBaseUrl;
  cachedEnv = {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? BASE_URL,
    clerkSecretKey,
    clerkPublishableKey,
    clerkJwtTemplate,
    clerkOrgId: resolveOptionalEnvValue("E2E_CLERK_ORG_ID", fallback),
    clerkOrgName: resolveEnvValue("E2E_CLERK_ORG_NAME", fallback, DEFAULT_CLERK_TEST_ORG_NAME),
    clerkTestEmail: resolveEnvValue("E2E_CLERK_TEST_EMAIL", fallback, DEFAULT_CLERK_TEST_EMAIL),
    sdpApiBaseUrl,
    webServerEnv: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
      CLERK_SECRET_KEY: clerkSecretKey,
      CLERK_JWT_TEMPLATE: clerkJwtTemplate,
      SDP_API_BASE_URL: sdpApiBaseUrl,
      NEXT_PUBLIC_SDP_API_BASE_URL: publicApiBaseUrl,
      NEXT_PUBLIC_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_SENTRY_DSN: "",
      PLAYWRIGHT_DISABLE_SENTRY: "1",
      NEXT_PUBLIC_CLERK_SIGN_IN_URL:
        process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ??
        fallback.NEXT_PUBLIC_CLERK_SIGN_IN_URL ??
        "/sign-in",
      NEXT_PUBLIC_CLERK_SIGN_UP_URL:
        process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL ??
        fallback.NEXT_PUBLIC_CLERK_SIGN_UP_URL ??
        "/sign-up",
      NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL:
        process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL ??
        fallback.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL ??
        "/dashboard",
      NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL:
        process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL ??
        fallback.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL ??
        "/dashboard",
      NODE_ENV: process.env.NODE_ENV ?? "development",
    },
  };

  return cachedEnv;
}
