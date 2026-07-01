import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import type { Env } from "@/types/env";

export async function resolveIssuedTokenLabelsByMint(
  c: Context<{ Bindings: Env }>
): Promise<Map<string, string>> {
  const auth = getAuth(c);
  const query = `
    SELECT mint_address, symbol
      FROM issued_tokens
     WHERE organization_id = ?
       AND mint_address IS NOT NULL
  `;

  try {
    const result = await getDb(c.env)
      .prepare(query)
      .bind(auth.organizationId)
      .all<{ mint_address?: string | null; symbol?: string | null }>();

    return new Map(
      (result.results ?? [])
        .map((row): [string, string] | null => {
          const mint = row.mint_address?.trim();
          const symbol = row.symbol?.trim();
          return mint && symbol ? [mint, symbol] : null;
        })
        .filter((entry): entry is [string, string] => entry !== null)
    );
  } catch (error) {
    // biome-ignore lint/security/noSecrets: Static log message, not a secret.
    console.error("resolveIssuedTokenLabelsByMint: failed to fetch issued token symbols", {
      requestId: c.get("requestId"),
      organizationId: auth.organizationId,
      projectId: auth.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}
