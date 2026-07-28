import type { SdpEnvironment } from "@sdp/types";
import type { AlSvmCluster } from "./types";

const ALPHALEDGER_API_BASES = {
  sandbox: "https://vf-solana-api.qa.alphaledger.com",
  production: "https://vf-solana-api.beta.alphaledger.com",
} as const satisfies Record<SdpEnvironment, string>;

type AlphaLedgerMethod = "POST" | "PATCH";

export class AlphaLedgerService {
  private apiKey: string;
  private apiBase: string;

  /**
   * @param apiKey - Bearer API key scoped to one AlphaLedger organization
   * @param environment - SDP environment; sandbox targets AlphaLedger QA, production targets beta
   */
  constructor(apiKey: string, environment: SdpEnvironment) {
    this.apiKey = apiKey;
    this.apiBase = ALPHALEDGER_API_BASES[environment];
  }

  /**
   * Send a JSON request to the AlphaLedger Vulcan Forge API.
   *
   * Vulcan Forge uses POST for creates and lookups and PATCH for updates ONLY,
   * authenticated with a Bearer API key scoped to one organization in the
   * tenant.
   *
   * @param method - HTTP method, POST (creates/lookups) or PATCH (updates)
   * @param path - API path, e.g. "/api/v1/financial-instruments"
   * @param body - JSON request body
   * @param svmCluster - Target SVM network, omitted to use the tenant default
   * @returns The parsed JSON response
   */
  async request<T>(
    method: AlphaLedgerMethod,
    path: string,
    body: unknown,
    svmCluster?: AlSvmCluster
  ): Promise<T> {
    const url =
      svmCluster === undefined
        ? `${this.apiBase}${path}`
        : `${this.apiBase}${path}?svmCluster=${svmCluster}`;
    const response = await fetch(url, {
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
