import type { SdpApiClient } from "@/lib/sdp-api";

/** A deployed token this org issued, offered as a wallet policy asset. */
export interface IssuedPolicyToken {
  token: string;
  name: string;
  mint: string;
}

const ISSUED_TOKEN_PAGE_SIZE = 100;

/**
 * This loop runs inside the policy page's blocking `Promise.all`, so it is bounded
 * rather than trusting the API to stop advertising more pages. Five pages is far past
 * any real project, and a mint can still be pasted by hand beyond it.
 */
const ISSUED_TOKEN_MAX_PAGES = 5;

interface IssuedTokenRow {
  mintAddress?: string | null;
  symbol?: string | null;
  name?: string | null;
}

interface IssuedTokenPage {
  data?: IssuedTokenRow[] | { tokens?: IssuedTokenRow[] };
  meta?: { hasMore?: boolean };
}

/**
 * Deployed tokens issued by the active project.
 *
 * Deliberately applies no cluster filter. `issued_tokens` has no cluster column and is
 * scoped by `project_id`, and the dashboard derives its environment from the selected
 * project, so project scoping already is the devnet/mainnet boundary. Filtering again
 * here would be redundant and would drift from the API.
 *
 * Never throws. The caller awaits this alongside the wallet and policy fetches in a
 * `Promise.all`, which rejects as a unit, so a throw here would take down policy
 * authoring. Every failure degrades to whatever was collected, which is an empty list
 * when the very first page fails.
 */
export async function getIssuedPolicyTokens(
  request: SdpApiClient["request"]
): Promise<IssuedPolicyToken[]> {
  const tokens: IssuedPolicyToken[] = [];

  try {
    for (let page = 1; page <= ISSUED_TOKEN_MAX_PAGES; page += 1) {
      const response = await request(
        `/v1/issuance/tokens?${new URLSearchParams({
          page: String(page),
          pageSize: String(ISSUED_TOKEN_PAGE_SIZE),
        }).toString()}`
      );
      if (!response.ok) {
        return tokens;
      }

      const json = (await response.json()) as IssuedTokenPage;
      const rows = Array.isArray(json.data) ? json.data : (json.data?.tokens ?? []);

      for (const row of rows) {
        // A token with no mint has not been deployed, so it cannot be a policy asset.
        const mint = typeof row?.mintAddress === "string" ? row.mintAddress.trim() : "";
        if (!mint) continue;

        const symbol = row.symbol?.trim();
        tokens.push({
          token: symbol || mint,
          name: row.name?.trim() || symbol || mint,
          mint,
        });
      }

      if (json.meta?.hasMore !== true) {
        return tokens;
      }

      if (page === ISSUED_TOKEN_MAX_PAGES) {
        console.warn(
          `[policy-assets] issued token list truncated at ${ISSUED_TOKEN_MAX_PAGES} pages; some issued tokens are not offered in the policy picker`
        );
      }
    }

    return tokens;
  } catch {
    return tokens;
  }
}
