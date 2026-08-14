/**
 * Kamino K-Vault catalogue inventory.
 *
 * Kamino's vault registry is permissionless, so `GET /kvaults/vaults` is a
 * census of everything ever created rather than a curated shelf — test vaults,
 * abandoned dust and $36M institutional vaults arrive in the same array. The
 * distillation in `@sdp/earn` therefore refuses the large majority of it, and a
 * gate that silently shrinks a catalogue needs its drops enumerated or nobody
 * can review the threshold that produced them.
 *
 * This script pulls the RAW registry, runs the exact distillation the sync uses
 * (`distillKaminoVault` — shared code, not a reimplementation), and reports
 * both sides: what enters the catalogue, and what was dropped and why.
 *
 * Layout mirrors inventory-ground-catalogue.ts:
 *   - inventory snapshot   apps/sdp-api/.earn-catalogue/kamino.inventory.json (committed)
 *   - rendered report      docs/earn/kamino-catalogue-inventory.md (committed)
 *
 *   pnpm --filter @sdp/api earn:inventory:kamino          # fetch + render
 *   pnpm --filter @sdp/api earn:inventory:kamino:render   # re-render, no network
 *
 * UNLIKE the Ground inventory this needs NO credential and has NO production
 * gate. Kamino's data API is public and read-only, and its K-Vaults exist only
 * on mainnet — there is no sandbox deployment to prefer, and no account whose
 * production side could be touched by mistake. There is exactly one shelf and
 * this reads it.
 *
 * Re-render only re-formats the committed snapshot; outcomes are baked in at
 * fetch time, so after changing a distillation gate you must re-`fetch`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  distillKaminoVault,
  KAMINO_MIN_TVL_USD,
  type KaminoCatalogueDropReason,
  KaminoEarnClient,
  kaminoTvlUsd,
} from "@sdp/earn/providers/kamino/client";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { z } from "zod";

const INVENTORY_ROOT = path.resolve(process.cwd(), ".earn-catalogue");
const INVENTORY_FILE = path.join(INVENTORY_ROOT, "kamino.inventory.json");
const REPORT_TARGET = path.resolve(process.cwd(), "../../docs/earn/kamino-catalogue-inventory.md");

/** Base58, the only shape a Solana pubkey can take. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Every field is CONSTRAINED, not merely typed, because each one is a value a
 * third party controls: anyone can create a Kamino vault and name it anything,
 * and this snapshot is committed to the repo. Bounding the free-text fields and
 * pinning the address-shaped ones is what keeps an upstream response from
 * writing unbounded or malformed content into a tracked file — the schema is
 * applied on WRITE as well as on read (see `runFetch`).
 */
const vaultRowSchema = z.object({
  address: z.string().regex(BASE58_ADDRESS),
  /** On-chain vault label; bounded because it is free text from upstream. */
  name: z.string().max(200),
  tokenMint: z.string().regex(BASE58_ADDRESS),
  /** Resolved symbol, or null when the mint is not a well-known token. */
  tokenSymbol: z.string().max(32).nullable(),
  tvlUsd: z.number().finite().nullable(),
  /** Recorded verbatim for the census, so bounded rather than pattern-matched. */
  apy: z.string().max(64).nullable(),
  holders: z.number().int().nonnegative().nullable(),
  outcome: z.enum(["catalogued", "dropped"]),
  dropReason: z.string().max(64).nullable(),
  sourceKind: z.string().max(32).nullable(),
});

const inventorySchema = z.object({
  fetchedAt: z.string(),
  minTvlUsd: z.number(),
  totalVaults: z.number(),
  rows: z.array(vaultRowSchema),
});

type VaultRow = z.infer<typeof vaultRowSchema>;
type Inventory = z.infer<typeof inventorySchema>;

/** Why a vault stayed out, in the order the distillation decides. */
const DROP_REASON_LABELS: Record<KaminoCatalogueDropReason, string> = {
  unknown_deposit_mint: "Deposit mint is not a well-known SDP token",
  not_a_deposit_token: "Known token, but outside Earn's stablecoin set",
  unnamed: "Vault has no on-chain name",
  no_metrics: "No metrics row — TVL could not be established",
  below_tvl_floor: `TVL below the $${KAMINO_MIN_TVL_USD.toLocaleString("en-US")} floor`,
};

/**
 * Escape a value for one markdown table cell.
 *
 * Backslash FIRST, then pipe — order is the whole point. Escaping only the pipe
 * leaves a trailing `\` in the input to pair with the `\` we add, so a vault
 * named `foo\` renders `foo\\|` : the backslash escapes itself and the pipe
 * becomes a live column separator, shifting every later cell in the row. Vault
 * names are attacker-controlled in the sense that anyone can create a Kamino
 * vault and name it anything, so this is the sanitiser, not a formality.
 */
function escapeCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatApy(apy: string | null): string {
  if (apy === null) return "—";
  return `${(Number(apy) * 100).toFixed(2)}%`;
}

function renderCataloguedTable(rows: readonly VaultRow[]): string {
  const catalogued = rows
    .filter((row) => row.outcome === "catalogued")
    .sort((left, right) => (right.tvlUsd ?? 0) - (left.tvlUsd ?? 0));

  if (catalogued.length === 0) {
    return "_Nothing catalogued._\n";
  }

  const lines = [
    "| Vault | Token | TVL | APY | Holders | Kind | Address |",
    "|---|---|---:|---:|---:|---|---|",
    ...catalogued.map(
      (row) =>
        `| ${[
          escapeCell(row.name),
          row.tokenSymbol ?? "—",
          formatUsd(row.tvlUsd),
          formatApy(row.apy),
          row.holders === null ? "—" : String(row.holders),
          row.sourceKind ?? "—",
          `\`${row.address}\``,
        ].join(" | ")} |`
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function renderDropCensus(rows: readonly VaultRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome === "dropped" && row.dropReason) {
      counts.set(row.dropReason, (counts.get(row.dropReason) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return "_Nothing dropped._\n";
  }

  const lines = [
    "| Reason | Vaults | What it means |",
    "|---|---:|---|",
    ...[...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([reason, count]) => {
        const label = DROP_REASON_LABELS[reason as KaminoCatalogueDropReason] ?? reason;
        return `| \`${reason}\` | ${count} | ${label} |`;
      }),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The near-misses. A size floor is only reviewable next to what it just barely
 * refused, so this lists every stablecoin vault dropped for size alone,
 * largest first — if a real vault is sitting just under the line, it shows up
 * here rather than vanishing into a count.
 */
function renderNearMissTable(rows: readonly VaultRow[], limit = 15): string {
  const nearMisses = rows
    .filter((row) => row.dropReason === "below_tvl_floor")
    .sort((left, right) => (right.tvlUsd ?? 0) - (left.tvlUsd ?? 0))
    .slice(0, limit);

  if (nearMisses.length === 0) {
    return "_No vault was dropped for size alone._\n";
  }

  const lines = [
    "| Vault | Token | TVL | Holders |",
    "|---|---|---:|---:|",
    ...nearMisses.map(
      (row) =>
        `| ${[
          escapeCell(row.name || "_(unnamed)_"),
          row.tokenSymbol ?? "—",
          formatUsd(row.tvlUsd),
          row.holders === null ? "—" : String(row.holders),
        ].join(" | ")} |`
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function renderTokenCensus(rows: readonly VaultRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.tokenSymbol ?? "(not a well-known token)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines = [
    "| Deposit token | Vaults |",
    "|---|---:|",
    ...[...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([symbol, count]) => `| ${symbol} | ${count} |`),
  ];
  return `${lines.join("\n")}\n`;
}

function renderReport(inventory: Inventory): string {
  const catalogued = inventory.rows.filter((row) => row.outcome === "catalogued").length;

  return `# Kamino catalogue inventory

<!-- Generated by apps/sdp-api/scripts/inventory-kamino-catalogue.ts — do not edit by hand. -->

Kamino's vault registry is permissionless, so the API lists every K-Vault ever
created. SDP catalogues the subset that is a stablecoin vault, is named, and
holds real money. This report is what that filter admits and refuses, so the
threshold behind it can be reviewed rather than taken on faith.

**Mainnet only.** \`/kvaults/*\` accepts no environment parameter and Kamino has
no devnet deployment, so there is one shelf and it is the mainnet one. SDP
catalogues it into BOTH the sandbox and production environments — sandbox rows
carry \`host_cluster = 'mainnet-beta'\` and are never fundable there.

**Every row is \`defi\`, and no row carries a curator.** Permissionless creation
means the vault NAME is chosen by whoever created it, so SDP quotes it but
never parses it into a claim. Some catalogued vaults really are RWA-backed and
really are run by a named house — Kamino publishes no field that establishes
either, and an assertion anyone could forge by naming a vault is worse than an
absent one. Both fields return when there is a verified source for them (see
\`packages/sdp-earn/src/providers/kamino/client.ts\`).

- Fetched: \`${inventory.fetchedAt}\`
- Vaults in the registry: **${inventory.totalVaults}**
- Catalogued by SDP: **${catalogued}**
- TVL floor: **$${inventory.minTvlUsd.toLocaleString("en-US")}** (\`KAMINO_MIN_TVL_USD\`)

## Catalogued

${renderCataloguedTable(inventory.rows)}
## Why the rest stayed out

${renderDropCensus(inventory.rows)}
### Dropped for size — the largest near-misses

Raise or lower \`KAMINO_MIN_TVL_USD\` and these are the vaults that move across
the line first.

${renderNearMissTable(inventory.rows)}
## The whole registry by deposit token

Earn V1 is a stablecoin facility (\`EARN_DEPOSIT_TOKEN_SYMBOLS\` = USDC, USDG,
USDT). Everything else here is what widening that union would put in reach.

${renderTokenCensus(inventory.rows)}`;
}

async function runFetch(): Promise<void> {
  const client = new KaminoEarnClient();

  console.log("Fetching the Kamino vault registry and bulk metrics…");
  const [vaults, metricsByVault] = await Promise.all([
    client._listVaults(),
    client._loadMetricsByVault(),
  ]);
  console.log(`  ${vaults.length} vaults, ${metricsByVault.size} metrics rows`);

  const rows: VaultRow[] = vaults.map((vault) => {
    const metrics = metricsByVault.get(vault.address);
    const distilled = distillKaminoVault(vault, metrics);
    // Shared with the client, not re-derived: the census prints the TVL beside
    // each row and the floor's verdict in the same table, so the two must be
    // the same number. The hand-rolled copy this replaced disagreed on the
    // exponent-form balances Kamino really sends.
    const tvlUsd = (metrics && kaminoTvlUsd(metrics)) ?? null;

    return {
      address: vault.address,
      name: (vault.state.name ?? "").trim(),
      tokenMint: vault.state.tokenMint,
      tokenSymbol: WELL_KNOWN_TOKEN_BY_MINT.get(vault.state.tokenMint)?.symbol ?? null,
      tvlUsd,
      apy: metrics?.apy ?? null,
      holders: metrics?.numberOfHolders ?? null,
      outcome: distilled.outcome,
      dropReason: distilled.outcome === "dropped" ? distilled.reason : null,
      sourceKind: distilled.outcome === "catalogued" ? distilled.snapshot.sourceKind : null,
    };
  });

  const inventory: Inventory = {
    fetchedAt: new Date().toISOString(),
    minTvlUsd: KAMINO_MIN_TVL_USD,
    totalVaults: vaults.length,
    rows,
  };

  // Validate BEFORE writing, not just when reading back. Everything above came
  // off the network and this file is committed, so the schema is the boundary
  // between an upstream response and a tracked artifact: a malformed or
  // unbounded field fails the script here rather than landing in the repo and
  // surfacing later as a render-time parse error.
  const validated = inventorySchema.parse(inventory);

  await mkdir(INVENTORY_ROOT, { recursive: true });
  await writeFile(INVENTORY_FILE, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  console.log(`  wrote ${path.relative(process.cwd(), INVENTORY_FILE)}`);
}

async function renderFromSnapshot(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(INVENTORY_FILE, "utf8");
  } catch {
    throw new Error(
      `No snapshot at ${path.relative(process.cwd(), INVENTORY_FILE)} — run \`pnpm --filter @sdp/api earn:inventory:kamino\` first.`
    );
  }
  const inventory = inventorySchema.parse(JSON.parse(raw));
  await writeFile(REPORT_TARGET, renderReport(inventory), "utf8");
  console.log(`Rendered ${path.relative(process.cwd(), REPORT_TARGET)}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "fetch";
  if (command === "fetch") {
    await runFetch();
    await renderFromSnapshot();
    return;
  }
  if (command === "render") {
    await renderFromSnapshot();
    return;
  }
  throw new Error(`Unknown command "${command}" — expected \`fetch\` or \`render\`.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
