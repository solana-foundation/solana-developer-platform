/**
 * Ground yield-source catalogue inventory (PRO-1638).
 *
 * The product doc's differentiator is RWA yield, and the catalogue-sync
 * pipeline silently shrinks what Ground offers before anyone sees it: sources
 * are dropped for inactive modes, for tokens Ground cannot route on Solana
 * rails, and for tokens without a mint on the environment's cluster. This
 * script pulls the RAW catalogue, runs the exact distillation the sync uses
 * (`distillGroundYieldSource` — shared code, not a reimplementation), and
 * reports both sides: what the sync persists and what was dropped, why,
 * and how each source classifies (rwa/defi) and attributes (curator). It then
 * renders the delta against the product doc's named RWA targets. API visibility
 * is deliberately separate: strategy reads hide Aave- and Morpho-related rows
 * after they have been indexed.
 *
 * Layout mirrors ramp-support.ts:
 *   - raw dumps            apps/sdp-api/.earn-catalogue/raw/   (gitignored)
 *   - inventory snapshots  apps/sdp-api/.earn-catalogue/ground.<env>.inventory.json (committed)
 *   - rendered report      docs/earn/ground-catalogue-inventory.md (committed)
 *
 *   pnpm --filter @sdp/api earn:inventory                      # fetch sandbox + render
 *   pnpm --filter @sdp/api earn:inventory:render               # re-render from snapshots, no network
 *
 * PRODUCTION: read-only (GETs only), but still a provider-production call —
 * never run it from a laptop (packages/sdp-earn/CLAUDE.md: sandbox base URL +
 * sandbox key only). From an approved environment with GROUND_API_KEY:
 *
 *   pnpm --filter @sdp/api earn:inventory -- --env production --confirm-production
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  classifySourceKind,
  deriveCurator,
  distillGroundYieldSource,
  GroundEarnClient,
  type GroundYieldSource,
  RWA_ALLOCATION_TYPE,
} from "@sdp/earn/providers/ground/client";
import type { EarnRuntimeContext } from "@sdp/earn/types";
import { earnCuratorLabel, type SdpEnvironment } from "@sdp/types";
import { z } from "zod";

const INVENTORY_ROOT = path.resolve(process.cwd(), ".earn-catalogue");
const RAW_DUMP_DIR = path.join(INVENTORY_ROOT, "raw");
const REPORT_TARGET = path.resolve(process.cwd(), "../../docs/earn/ground-catalogue-inventory.md");

const SDP_ENVIRONMENTS = ["sandbox", "production"] as const;

/**
 * The product doc's named RWA candidates ("SDP - Solana Earn", Notion), plus
 * the two it flags as later arrivals. Matching is a keyword heuristic over
 * id + name + protocol — the report also lists every unmatched source, so a
 * target hiding under an unexpected name is caught by eyeball, not lost.
 */
const PRODUCT_DOC_RWA_TARGETS = [
  { label: "BUIDL (BlackRock)", pattern: /buidl|blackrock/i },
  { label: "BENJI (Franklin Templeton)", pattern: /benji|franklin/i },
  { label: "SWEEP (Galaxy)", pattern: /sweep|galaxy/i },
  { label: "OUSG (Ondo)", pattern: /ousg/i },
  { label: "USDY (Ondo)", pattern: /usdy/i },
  { label: "BAGEY (Baillie Gifford)", pattern: /bagey|baillie/i },
  { label: "USDe (Ethena)", pattern: /\busde\b|ethena/i },
  { label: "Figure PRIME", pattern: /figure/i },
  { label: "Syrup USDC (Maple)", pattern: /syrup/i },
  { label: "AAA CLO (Janus Henderson JAAA)", pattern: /jaaa|aaa[\s-]?clo/i },
  { label: "JPM JOLT (later arrival)", pattern: /jolt|jpmorgan|\bjpm\b/i },
  { label: "BlackRock B-reserves (later arrival)", pattern: /b[\s-]?reserves/i },
] as const;

const allocationSchema = z.object({
  label: z.string(),
  type: z.string().nullable(),
  pct: z.number().nullable(),
});

const sourceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.string(),
  /** Where the source itself sits; see GroundYieldSource.chain. */
  chain: z.string().nullable(),
  depositToken: z.string(),
  protocol: z.string().nullable(),
  apyBps: z.number().nullable(),
  tvlUsd: z.number().nullable(),
  utilizationPct: z.number().nullable(),
  allocations: z.array(allocationSchema),
  sourceKind: z.enum(["defi", "rwa"]),
  curator: z.string().nullable(),
  outcome: z.enum(["catalogued", "dropped"]),
  dropReason: z
    .enum([
      "inactive_mode",
      "not_solana_routable",
      // Accepted so older committed snapshots remain renderable. Current
      // distillation no longer drops a source because of its host chain.
      "not_solana_hosted",
      "unknown_token_symbol",
      "no_cluster_mint",
    ])
    .nullable(),
  liquidityTerm: z.enum(["instant", "delayed"]).nullable(),
  redemptionDelayDays: z.number().nullable(),
});

const inventorySchema = z.object({
  provider: z.literal("ground"),
  environment: z.enum(SDP_ENVIRONMENTS),
  fetchedAt: z.string(),
  sources: z.array(sourceRowSchema),
});

type SourceRow = z.infer<typeof sourceRowSchema>;
type Inventory = z.infer<typeof inventorySchema>;

function inventoryFile(environment: SdpEnvironment): string {
  return path.join(INVENTORY_ROOT, `ground.${environment}.inventory.json`);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toSourceRow(source: GroundYieldSource, environment: SdpEnvironment): SourceRow {
  const distilled = distillGroundYieldSource(source, environment);
  return {
    id: source.id,
    name: source.name,
    mode: source.mode,
    chain: source.chain ?? null,
    depositToken: source.depositToken,
    protocol: source.protocol ?? null,
    apyBps: source.apyBps ?? null,
    tvlUsd: source.tvlUsd ?? null,
    utilizationPct: source.utilizationPct ?? null,
    allocations: (source.allocations ?? []).map((allocation) => ({
      label: allocation.label,
      type: allocation.type ?? null,
      pct: allocation.pct ?? null,
    })),
    // Classified for EVERY source, dropped ones included: an `rwa` row on the
    // dropped side is RWA coverage Ground has that SDP does not surface —
    // the exact loss PRO-1638 exists to quantify.
    sourceKind: classifySourceKind(source.allocations),
    curator: deriveCurator(source) ?? null,
    outcome: distilled.outcome,
    dropReason: distilled.outcome === "dropped" ? distilled.reason : null,
    liquidityTerm: distilled.outcome === "catalogued" ? distilled.snapshot.liquidityTerm : null,
    redemptionDelayDays:
      distilled.outcome === "catalogued" ? (distilled.snapshot.redemptionDelayDays ?? null) : null,
  };
}

// --- Rendering ---

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function formatApy(apyBps: number | null): string {
  return apyBps == null ? "—" : `${(apyBps / 100).toFixed(2)}%`;
}

function formatUsd(value: number | null): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

/**
 * Derived curator id plus the dashboard's display label when one is mapped —
 * the acceptance question is what the DASHBOARD shows, and a raw id here with
 * no label arrow means the UI would render the raw id.
 */
function formatCurator(curator: string | null): string {
  if (curator === null) {
    return "—";
  }
  const label = earnCuratorLabel(curator);
  return label === curator ? `\`${curator}\`` : `\`${curator}\` → ${escapeCell(label)}`;
}

function formatLiquidity(row: SourceRow): string {
  if (row.liquidityTerm === null) {
    return "—";
  }
  if (row.liquidityTerm === "instant") {
    return "instant";
  }
  return row.redemptionDelayDays == null ? "delayed" : `delayed ${row.redemptionDelayDays}d`;
}

/** e.g. `market 60 / treasury 40` — the weights behind the rwa/defi call. */
function formatAllocations(row: SourceRow): string {
  if (row.allocations.length === 0) {
    return "(none)";
  }
  return row.allocations
    .map((allocation) => {
      const type = allocation.type ?? "untyped";
      return allocation.pct == null ? type : `${type} ${Number(allocation.pct.toFixed(2))}`;
    })
    .join(" / ");
}

function renderCataloguedTable(rows: readonly SourceRow[]): string {
  const lines = [
    "| id | name | kind | host chain | curator | token | APY | TVL (USD) | liquidity | allocations |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| \`${row.id}\` | ${escapeCell(row.name)} | **${row.sourceKind}** | ${row.chain ?? "—"} | ${formatCurator(row.curator)} | ${row.depositToken} | ${formatApy(row.apyBps)} | ${formatUsd(row.tvlUsd)} | ${formatLiquidity(row)} | ${escapeCell(formatAllocations(row))} |`
    );
  }
  return lines.join("\n");
}

/** Where Ground hosts the sources the sync persists. */
function renderHostChainCensus(rows: readonly SourceRow[]): string {
  const counts = new Map<string, { total: number; rwa: number }>();
  for (const row of rows) {
    const chain = row.chain ?? "(unreported)";
    const entry = counts.get(chain) ?? { total: 0, rwa: 0 };
    entry.total += 1;
    if (row.sourceKind === "rwa") {
      entry.rwa += 1;
    }
    counts.set(chain, entry);
  }
  const lines = ["| host chain | catalogued sources | of which RWA |", "| --- | --- | --- |"];
  for (const [chain, entry] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| \`${chain}\` | ${entry.total} | ${entry.rwa} |`);
  }
  return lines.join("\n");
}

function renderDroppedTable(rows: readonly SourceRow[]): string {
  const lines = [
    "| id | name | kind¹ | curator¹ | token | mode | drop reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| \`${row.id}\` | ${escapeCell(row.name)} | **${row.sourceKind}** | ${formatCurator(row.curator)} | ${row.depositToken} | ${row.mode} | \`${row.dropReason}\` |`
    );
  }
  return lines.join("\n");
}

function renderAllocationCensus(rows: readonly SourceRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const allocation of row.allocations) {
      const type = allocation.type ?? "(untyped)";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  const lines = ["| allocation `type` | sleeves | counts as RWA |", "| --- | --- | --- |"];
  for (const [type, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rwa = type !== "(untyped)" && RWA_ALLOCATION_TYPE.test(type) ? "yes" : "no";
    lines.push(`| \`${type}\` | ${count} | ${rwa} |`);
  }
  return lines.join("\n");
}

function renderDocDelta(rows: readonly SourceRow[]): string {
  const lines = ["| product-doc RWA target | status | matched source |", "| --- | --- | --- |"];
  for (const target of PRODUCT_DOC_RWA_TARGETS) {
    const matches = rows.filter((row) =>
      target.pattern.test(`${row.id} ${row.name} ${row.protocol ?? ""}`)
    );
    if (matches.length === 0) {
      lines.push(`| ${target.label} | **absent** | — |`);
      continue;
    }
    for (const match of matches) {
      const status =
        match.outcome === "catalogued"
          ? match.sourceKind === "rwa"
            ? "catalogued as `rwa`"
            : "catalogued, but classifies `defi`"
          : `present but dropped (\`${match.dropReason}\`)`;
      lines.push(`| ${target.label} | ${status} | \`${match.id}\` |`);
    }
  }
  return lines.join("\n");
}

function renderEnvironmentSection(inventory: Inventory): string {
  const catalogued = inventory.sources.filter((row) => row.outcome === "catalogued");
  const dropped = inventory.sources.filter((row) => row.outcome === "dropped");
  const kindCount = (rows: readonly SourceRow[], kind: SourceRow["sourceKind"]): number =>
    rows.filter((row) => row.sourceKind === kind).length;
  const dropCounts = new Map<string, number>();
  for (const row of dropped) {
    const reason = row.dropReason ?? "unknown";
    dropCounts.set(reason, (dropCounts.get(reason) ?? 0) + 1);
  }
  const dropSummary =
    dropped.length === 0
      ? "none"
      : [...dropCounts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([reason, count]) => `${count} × \`${reason}\``)
          .join(", ");

  const byKindThenId = (a: SourceRow, b: SourceRow): number =>
    a.sourceKind === b.sourceKind ? a.id.localeCompare(b.id) : a.sourceKind === "rwa" ? -1 : 1;

  return [
    `## Environment: ${inventory.environment}`,
    "",
    `Fetched ${inventory.fetchedAt} · **${inventory.sources.length} raw sources** → ` +
      `**${catalogued.length} catalogued** (${kindCount(catalogued, "rwa")} rwa / ${kindCount(catalogued, "defi")} defi) · ` +
      `**${dropped.length} dropped** (${dropSummary})`,
    "",
    "### Catalogued sources",
    "",
    renderCataloguedTable([...catalogued].sort(byKindThenId)),
    "",
    "### Dropped sources — never reach the catalogue",
    "",
    "¹ kind/curator show how the source WOULD classify: an `rwa` row here is RWA coverage",
    "Ground carries that SDP does not surface, and the drop reason says which gate cost it.",
    "",
    renderDroppedTable([...dropped].sort(byKindThenId)),
    "",
    "### Host-chain census — what is actually Solana-native",
    "",
    "SDP's customer-facing deposit and payout rails remain Solana-only. Ground may",
    "bridge that USDC to a source it hosts elsewhere, so host chain is inventory",
    "metadata rather than a persistence gate. Aave- and Morpho-related rows are",
    "still represented here even though strategy API reads hide them.",
    "",
    renderHostChainCensus(catalogued),
    "",
    "### Allocation-type census",
    "",
    "Every allocation `type` Ground emitted, against the `RWA_ALLOCATION_TYPE` classifier —",
    "the classifier was calibrated on observed values, so a new type appearing here as",
    "`no` deserves a look before trusting the rwa/defi split.",
    "",
    renderAllocationCensus(inventory.sources),
    "",
    "### Product-doc RWA target delta",
    "",
    renderDocDelta(inventory.sources),
  ].join("\n");
}

function renderMissingEnvironmentSection(environment: SdpEnvironment): string {
  const how =
    environment === "production"
      ? "Requires `GROUND_API_KEY` and must run from an approved environment — never a laptop\n" +
        "(packages/sdp-earn/CLAUDE.md: provider sandbox only). Run:\n" +
        "`pnpm --filter @sdp/api earn:inventory -- --env production --confirm-production`"
      : "Run: `pnpm --filter @sdp/api earn:inventory`";
  return `## Environment: ${environment}\n\n_Not yet inventoried._ ${how}`;
}

async function readInventory(environment: SdpEnvironment): Promise<Inventory | undefined> {
  let text: string;
  try {
    text = await readFile(inventoryFile(environment), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return inventorySchema.parse(JSON.parse(text));
}

async function renderReport(): Promise<void> {
  const sections: string[] = [];
  for (const environment of SDP_ENVIRONMENTS) {
    const inventory = await readInventory(environment);
    sections.push(
      inventory === undefined
        ? renderMissingEnvironmentSection(environment)
        : renderEnvironmentSection(inventory),
      ""
    );
  }

  const report = [
    "# Ground yield-source catalogue inventory",
    "",
    "<!-- AUTO-GENERATED by apps/sdp-api/scripts/inventory-ground-catalogue.ts — do not edit by hand.",
    "     Refresh sandbox: pnpm --filter @sdp/api earn:inventory",
    "     Re-render only:  pnpm --filter @sdp/api earn:inventory:render -->",
    "",
    "What Ground actually offers versus what the Earn V1 product doc promises",
    "([PRO-1638](https://linear.app/solana-fndn/issue/PRO-1638)). Raw catalogue pulled from",
    "`GET /v2/wallets/yield-sources`, distilled with the same `distillGroundYieldSource`",
    "the catalogue sync uses, so the catalogued/dropped split below is exactly what the",
    "sync persists — not a parallel interpretation. Strategy API reads separately hide",
    "Aave- and Morpho-related rows while retaining them in the database.",
    "",
    ...sections,
    "",
  ].join("\n");

  await mkdir(path.dirname(REPORT_TARGET), { recursive: true });
  await writeFile(REPORT_TARGET, report, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), REPORT_TARGET)}`);
}

// --- Commands ---

function parseEnvironment(args: readonly string[]): SdpEnvironment {
  const index = args.indexOf("--env");
  const value = index === -1 ? "sandbox" : args[index + 1];
  if (value !== "sandbox" && value !== "production") {
    throw new Error(`--env must be one of ${SDP_ENVIRONMENTS.join("|")}, got: ${value}`);
  }
  return value;
}

async function runFetch(args: readonly string[]): Promise<void> {
  const environment = parseEnvironment(args);
  if (environment === "production") {
    if (!args.includes("--confirm-production")) {
      throw new Error(
        "Refusing to read Ground PRODUCTION without --confirm-production. " +
          "Never run this from a laptop — provider sandbox only (packages/sdp-earn/CLAUDE.md); " +
          "run it from an approved environment with GROUND_API_KEY."
      );
    }
    console.warn("Read-only inventory against Ground PRODUCTION (GETs only).");
  }

  const ctx: EarnRuntimeContext = { env: process.env, environment };
  const client = new GroundEarnClient();

  const raw: GroundYieldSource[] = [];
  for await (const source of client._iterateYieldSources(ctx)) {
    raw.push(source);
  }
  await writeJsonFile(path.join(RAW_DUMP_DIR, `ground.${environment}.json`), raw);

  const inventory: Inventory = {
    provider: "ground",
    environment,
    fetchedAt: new Date().toISOString(),
    sources: raw
      .map((source) => toSourceRow(source, environment))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  await writeJsonFile(inventoryFile(environment), inventory);

  const catalogued = inventory.sources.filter((row) => row.outcome === "catalogued").length;
  console.log(
    `[ground/${environment}] ${inventory.sources.length} raw sources → ${catalogued} catalogued, ` +
      `${inventory.sources.length - catalogued} dropped; wrote ${path.relative(process.cwd(), inventoryFile(environment))}`
  );

  await renderReport();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  switch (command) {
    case "fetch":
      await runFetch(args.slice(1));
      break;
    case "render":
      await renderReport();
      break;
    default:
      throw new Error(
        "Usage: inventory-ground-catalogue.ts <fetch|render> [--env sandbox|production] [--confirm-production]"
      );
  }
}

void main();
