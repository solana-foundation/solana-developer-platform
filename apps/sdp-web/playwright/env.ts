import fs from "node:fs";
import path from "node:path";

const DEFAULT_CLERK_TEST_ORG_NAME = "Solana";
const DEFAULT_CLERK_TEST_EMAIL = "e2e-smoke+sdp-web@example.com";
const BASE_URL = "http://localhost:3100";
const GCP_DEV_API_URL = "https://api-dev.solana.com";

type E2EEnvCommon = {
  baseURL: string;
  clerkSecretKey: string;
  clerkPublishableKey: string;
  clerkJwtTemplate: string;
  clerkOrgName: string;
  clerkTestEmail: string;
  sdpApiBaseUrl: string;
  webServerEnv: Record<string, string>;
};

type E2EEnv = E2EEnvCommon &
  (
    | {
        clerkOrgId: string;
        expectedProjectId: string;
        useExternalApi: true;
      }
    | {
        clerkOrgId: string | null;
        expectedProjectId: null;
        useExternalApi: false;
      }
  );

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

function resolveExplicitEnvValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`External GCP smoke requires an explicit ${name}`);
  }
  return value;
}

let cachedEnv: E2EEnv | null = null;

export function getE2EEnv(): E2EEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const fallback = getFallbackEnv();
  const useExternalApi = process.env.PLAYWRIGHT_USE_EXTERNAL_API === "1";
  if (useExternalApi && process.env.PLAYWRIGHT_USE_NEXT_START !== "1") {
    throw new Error("External GCP smoke requires PLAYWRIGHT_USE_NEXT_START=1");
  }
  if (useExternalApi && process.env.NODE_ENV !== "production") {
    throw new Error("External GCP smoke requires NODE_ENV=production");
  }
  const explicitExternalApiUrl = useExternalApi
    ? resolveExplicitEnvValue("PLAYWRIGHT_API_URL").replace(/\/$/, "")
    : null;
  if (explicitExternalApiUrl && explicitExternalApiUrl !== GCP_DEV_API_URL) {
    throw new Error(
      `External GCP smoke only accepts ${GCP_DEV_API_URL}; received ${explicitExternalApiUrl}`
    );
  }

  const clerkSecretKey = resolveEnvValue("CLERK_SECRET_KEY", fallback);
  const clerkPublishableKey = resolveEnvValue("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", fallback);
  const clerkJwtTemplate = resolveEnvValue("CLERK_JWT_TEMPLATE", fallback, "sdp-api");
  const sdpApiBaseUrl =
    explicitExternalApiUrl ??
    resolveEnvValue(
      "SDP_API_BASE_URL",
      {
        ...fallback,
        SDP_API_BASE_URL:
          fallback.SDP_API_BASE_URL ||
          fallback.NEXT_PUBLIC_SDP_API_BASE_URL ||
          fallback.NEXT_PUBLIC_API_BASE_URL,
      },
      GCP_DEV_API_URL
    );
  const publicApiBaseUrl =
    process.env.NEXT_PUBLIC_SDP_API_BASE_URL ??
    fallback.NEXT_PUBLIC_SDP_API_BASE_URL ??
    sdpApiBaseUrl;
  const identityEnv = useExternalApi
    ? {
        clerkOrgId: resolveExplicitEnvValue("E2E_CLERK_ORG_ID"),
        clerkTestEmail: resolveExplicitEnvValue("E2E_CLERK_TEST_EMAIL"),
        expectedProjectId: resolveExplicitEnvValue("E2E_SDP_PROJECT_ID"),
        useExternalApi: true as const,
      }
    : {
        clerkOrgId: resolveOptionalEnvValue("E2E_CLERK_ORG_ID", fallback),
        clerkTestEmail: resolveEnvValue("E2E_CLERK_TEST_EMAIL", fallback, DEFAULT_CLERK_TEST_EMAIL),
        expectedProjectId: null,
        useExternalApi: false as const,
      };
  cachedEnv = {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? BASE_URL,
    clerkSecretKey,
    clerkPublishableKey,
    clerkJwtTemplate,
    clerkOrgName: resolveEnvValue("E2E_CLERK_ORG_NAME", fallback, DEFAULT_CLERK_TEST_ORG_NAME),
    ...identityEnv,
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
