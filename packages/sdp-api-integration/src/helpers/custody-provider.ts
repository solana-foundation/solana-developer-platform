import { env } from "#env-impl";

export type IntegrationCustodyProvider = "local" | "privy";

type IntegrationEnv = typeof env & {
  SDP_INTEGRATION_CUSTODY_PROVIDER?: string;
};

export function getIntegrationCustodyProvider(): IntegrationCustodyProvider {
  const raw = (env as IntegrationEnv).SDP_INTEGRATION_CUSTODY_PROVIDER;
  if (!raw) {
    return "privy";
  }
  if (raw === "local" || raw === "privy") {
    return raw;
  }

  throw new Error(`Invalid SDP_INTEGRATION_CUSTODY_PROVIDER: ${raw}. Expected "local" or "privy".`);
}
