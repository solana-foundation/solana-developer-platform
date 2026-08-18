import type { EarnPortfolioAllocationInput } from "@sdp/types";

/**
 * Request snippets for the Earn API, built only from routes that actually
 * exist today under `/v1/earn`. Nothing here is aspirational: there is no
 * partner deposit-signing handshake in V1 — funding is "send stablecoins to
 * the program's Solana address" — so no snippet implies one.
 *
 * Shape follows the API playground's `buildFetchSnippet`: a `const API_KEY`
 * placeholder plus a bearer header, so a developer can paste either into the
 * playground or straight into a script.
 *
 * An API key carries its own project and environment, so key-authenticated
 * calls never send the `x-project-id` header the dashboard's session calls need.
 */

export interface EarnSnippet {
  id: "browse" | "read" | "switch" | "withdraw";
  /** Method + path, shown as the snippet's caption. */
  request: string;
  code: string;
}

const KEY_PLACEHOLDER = 'const API_KEY = "<your_secret_key>";';

function requestSnippet({
  baseUrl,
  body,
  method,
  path,
}: {
  baseUrl: string;
  body?: unknown;
  method: string;
  path: string;
}): string {
  const lines = [
    KEY_PLACEHOLDER,
    "",
    `const response = await fetch("${baseUrl}${path}", {`,
    `  method: "${method}",`,
    "  headers: {",
    // Escaped so this stays literal snippet text — the placeholder is meant to
    // reach the reader's clipboard, not be interpolated here.
    `    Authorization: \`Bearer \${API_KEY}\`,`,
  ];
  if (body !== undefined) {
    lines.push('    "Content-Type": "application/json",');
  }
  lines.push("  },");
  if (body !== undefined) {
    const json = JSON.stringify(body, null, 2)
      .split("\n")
      .map((line, index) => (index === 0 ? line : `  ${line}`))
      .join("\n");
    lines.push(`  body: JSON.stringify(${json}),`);
  }
  lines.push("});", "", "const { data } = await response.json();");
  return lines.join("\n");
}

/**
 * The four calls that reproduce and operate what the flow just created.
 * `allocations` is the exact payload confirmed in the wizard, so the switch
 * snippet is a runnable record of this program rather than a generic example.
 */
export function earnApiSnippets({
  allocations,
  baseUrl,
  programId,
  withdrawalToken,
}: {
  allocations: EarnPortfolioAllocationInput;
  baseUrl: string;
  /**
   * The REAL id of the program this run just wrote, not a `<program_id>`
   * placeholder — every snippet on this screen is meant to be runnable as
   * pasted, which is the whole point of showing them here.
   */
  programId: string;
  withdrawalToken: string;
}): readonly EarnSnippet[] {
  const programPath = `/v1/earn/programs/${programId}`;
  return [
    {
      id: "read",
      request: `GET ${programPath}`,
      code: requestSnippet({ baseUrl, method: "GET", path: programPath }),
    },
    {
      id: "browse",
      request: "GET /v1/earn/strategies",
      code: requestSnippet({
        baseUrl,
        method: "GET",
        path: "/v1/earn/strategies?pageSize=20&liquidityTerm=instant",
      }),
    },
    {
      id: "switch",
      request: `PUT ${programPath}`,
      code: requestSnippet({
        baseUrl,
        // requestId is what makes a retry safe: the provider replays the original
        // response for a matching payload. Mint a NEW one whenever allocations
        // change, or the reused key conflicts.
        body: { requestId: "<uuid_v4>", allocations },
        method: "PUT",
        path: programPath,
      }),
    },
    {
      id: "withdraw",
      request: `POST ${programPath}/withdrawals`,
      code: requestSnippet({
        baseUrl,
        // amountUsd is a USD decimal STRING (max 6 dp) on this family — never
        // a number and never base units.
        body: {
          // Required on this route, and the only thing that makes a retry
          // safe: the same value replays the original withdrawal instead of
          // paying out twice. Send the Idempotency-Key header instead if you
          // prefer — exactly one of the two, never both and never neither.
          requestId: "<uuid_v4>",
          amountUsd: "1000.00",
          token: withdrawalToken,
          destinationAddress: "<your_solana_address>",
        },
        method: "POST",
        path: `${programPath}/withdrawals`,
      }),
    },
  ];
}
