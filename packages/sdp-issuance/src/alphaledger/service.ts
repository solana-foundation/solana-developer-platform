import type { SdpEnvironment } from "@sdp/types";
import type { AlSvmCluster } from "./types";

const ALPHALEDGER_ENVIRONMENTS = {
  sandbox: {
    apiBase: "https://vf-solana-api.qa.alphaledger.com",
    svmCluster: "SOLANA_DEVNET",
  },
  production: {
    apiBase: "https://vf-solana-api.beta.alphaledger.com",
    svmCluster: "SOLANA_MAINNET_TESTING",
  },
} as const satisfies Record<SdpEnvironment, { apiBase: string; svmCluster: AlSvmCluster }>;

type AlphaLedgerMethod = "POST" | "PATCH";

export class AlphaLedgerService {
  private apiKey: string;
  private apiBase: string;
  private svmCluster: AlSvmCluster;

  /**
   * @param apiKey - Bearer API key scoped to one AlphaLedger organization
   * @param environment - SDP environment; sandbox targets AlphaLedger QA on
   * SOLANA_DEVNET, production targets beta on SOLANA_MAINNET_TESTING (their
   * beta tenant does not expose SOLANA_MAINNET)
   */
  constructor(apiKey: string, environment: SdpEnvironment) {
    this.apiKey = apiKey;
    this.apiBase = ALPHALEDGER_ENVIRONMENTS[environment].apiBase;
    this.svmCluster = ALPHALEDGER_ENVIRONMENTS[environment].svmCluster;
  }

  /**
   * Send a JSON request to the AlphaLedger Vulcan Forge API.
   *
   * Vulcan Forge uses POST for creates and lookups and PATCH for updates ONLY,
   * authenticated with a Bearer API key scoped to one organization in the
   * tenant. Every request explicitly targets the environment's SVM cluster
   * rather than relying on the tenant default.
   *
   * @param method - HTTP method, POST (creates/lookups) or PATCH (updates)
   * @param path - API path, e.g. "/api/v1/financial-instruments"
   * @param body - JSON request body
   * @returns The parsed JSON response
   */
  async request<T>(method: AlphaLedgerMethod, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}?svmCluster=${this.svmCluster}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `AlphaLedger ${method} ${path} failed (${response.status}): ${await response.text()}`
      );
    }
    return (await response.json()) as T;
  }
}
