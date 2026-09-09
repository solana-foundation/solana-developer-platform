/**
 * Veda vault catalogue inventory.
 *
 * Veda's shelf is the opposite of Kamino's: not a permissionless census to be
 * filtered down, but an explicit allowlist of vault-state addresses Veda named
 * (`VEDA_DEPLOYMENTS` in `@sdp/types/veda-programs`). So the interesting
 * question is not "what did the floor refuse" — it is "for each vault SDP was
 * given, what does the chain actually say, and what did that turn into on the
 * shelf?"
 *
 * That still needs enumerating, for the same reason Kamino's does: a vault's
 * enabled assets, pause flags, fees, share lock and withdraw authority all
 * decide what a customer is shown, and every one of them is read positionally
 * off an account nobody looks at by hand.
 *
 * Uses the SAME code the hourly sync uses — `readVedaVaults` for the read,
 * `isVedaDepositMint` for the admission rule, `vedaVaultName` and
 * `vedaLiquidity` for the mapping — so the report cannot disagree with the
 * catalogue it describes.
 *
 * Layout mirrors inventory-kamino-catalogue.ts:
 *   - inventory snapshot   apps/sdp-api/.earn-catalogue/veda.inventory.json (committed)
 *   - rendered report      docs/earn/veda-catalogue-inventory.md (committed)
 *
 *   pnpm --filter @sdp/api earn:inventory:veda          # fetch + render
 *   pnpm --filter @sdp/api earn:inventory:veda:render   # re-render, no network
 *
 * NO credential, like Kamino's: Veda is read entirely on chain. It does need an
 * RPC endpoint per cluster (`SOLANA_DEVNET_RPC_URL` / `SOLANA_MAINNET_RPC_URL`),
 * and `readVedaVaults` proves each endpoint's genesis hash before reading a
 * single account — so a mainnet URL in the devnet slot fails loudly instead of
 * quietly inventorying the wrong chain.
 *
 * Re-render only re-formats the committed snapshot; outcomes are baked in at
 * fetch time, so after changing an admission rule you must re-`fetch`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { vedaLiquidity, vedaVaultName } from "@sdp/earn/providers/veda/client";
import { readVedaVaults, VEDA_UNSET_AUTHORITY } from "@sdp/earn/providers/veda/vault-state";
import { SOLANA_CLUSTERS, type SolanaCluster, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import {
  isVedaDepositMint,
  VEDA_DEPOSIT_TOKEN_SYMBOLS,
  vedaDeployment,
} from "@sdp/types/veda-programs";
import { z } from "zod";

const INVENTORY_ROOT = path.resolve(process.cwd(), ".earn-catalogue");
const INVENTORY_FILE = path.join(INVENTORY_ROOT, "veda.inventory.json");
const REPORT_TARGET = path.resolve(process.cwd(), "../../docs/earn/veda-catalogue-inventory.md");

/** Base58, the only shape a Solana pubkey can take. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Bounded as well as typed. Everything below is decoded from account data a
 * third party writes, and this snapshot is committed to the repo — the schema
 * is the boundary between chain bytes and a tracked file, and it is applied on
 * WRITE as well as on read (see `runFetch`).
 */
const assetRowSchema = z.object({
  mint: z.string().regex(BASE58_ADDRESS),
  symbol: z.string().max(32).nullable(),
  allowDeposits: z.boolean(),
  allowWithdrawals: z.boolean(),
  /** Whether SDP fronts this mint — the shared `isVedaDepositMint` rule. */
  admitted: z.boolean(),
});

const vaultRowSchema = z.object({
  address: z.string().regex(BASE58_ADDRESS),
  vaultId: z.string().regex(/^\d+$/),
  name: z.string().max(200),
  shareMint: z.string().regex(BASE58_ADDRESS),
  baseAsset: z.string().regex(BASE58_ADDRESS),
  baseAssetSymbol: z.string().max(32).nullable(),
  shareDecimals: z.number().int().min(0).max(9),
  accountingPaused: z.boolean(),
  tellerPaused: z.boolean(),
  complianceMode: z.boolean(),
  /** `null` when redemption is permissionless. */
  withdrawAuthority: z.string().regex(BASE58_ADDRESS).nullable(),
  lockDurationSeconds: z.string().regex(/^-?\d+$/),
  platformFeeBps: z.number().int().min(0).max(10_000),
  performanceFeeBps: z.number().int().min(0).max(10_000),
  assets: z.array(assetRowSchema),
  outcome: z.enum(["catalogued", "dropped"]),
  dropReason: z.string().max(64).nullable(),
  depositMints: z.array(z.string().regex(BASE58_ADDRESS)),
  liquidityTerm: z.enum(["instant", "delayed"]),
  redemptionDelayDays: z.number().int().nonnegative().nullable(),
});

const clusterSchema = z.object({
  cluster: z.enum(SOLANA_CLUSTERS),
  /** Why this cluster contributed nothing, or `null` when it was read. */
  skipped: z.string().max(200).nullable(),
  configuredVaults: z.number().int().nonnegative(),
  rows: z.array(vaultRowSchema),
});

const inventorySchema = z.object({
  fetchedAt: z.string(),
  declaredDepositTokens: z.array(z.string().max(32)),
  clusters: z.array(clusterSchema),
});

type AssetRow = z.infer<typeof assetRowSchema>;
type VaultRow = z.infer<typeof vaultRowSchema>;
type ClusterInventory = z.infer<typeof clusterSchema>;
type Inventory = z.infer<typeof inventorySchema>;

function rpcUrlFor(cluster: SolanaCluster): string {
  const value =
    cluster === "devnet" ? process.env.SOLANA_DEVNET_RPC_URL : process.env.SOLANA_MAINNET_RPC_URL;
  return (value ?? "").trim();
}

async function inventoryCluster(cluster: SolanaCluster): Promise<ClusterInventory> {
  const deployment = vedaDeployment(cluster);
  if (!deployment) {
    return {
      cluster,
      skipped: "SDP has no confirmed Veda deployment for this cluster",
      configuredVaults: 0,
      rows: [],
    };
  }

  const rpcUrl = rpcUrlFor(cluster);
  if (rpcUrl === "") {
    return {
      cluster,
      skipped: `set SOLANA_${cluster === "devnet" ? "DEVNET" : "MAINNET"}_RPC_URL to inventory this cluster`,
      configuredVaults: deployment.vaultStateAddresses.length,
      rows: [],
    };
  }

  console.log(`Reading ${deployment.vaultStateAddresses.length} ${cluster} vault(s)…`);
  const entries = await readVedaVaults(rpcUrl, cluster, deployment);

  const rows = entries.map((entry): VaultRow => {
    const assets: AssetRow[] = entry.assets
      .map((asset) => ({
        mint: asset.assetMint,
        symbol: WELL_KNOWN_TOKEN_BY_MINT.get(asset.assetMint)?.symbol ?? null,
        allowDeposits: asset.allowDeposits,
        allowWithdrawals: asset.allowWithdrawals,
        admitted: asset.allowDeposits && isVedaDepositMint(asset.assetMint, cluster),
      }))
      .sort((left, right) => left.mint.localeCompare(right.mint));

    const depositMints = assets.filter((asset) => asset.admitted).map((asset) => asset.mint);
    const liquidity = vedaLiquidity(entry);

    return {
      address: entry.vault.address,
      vaultId: entry.vault.vaultId.toString(),
      name: vedaVaultName(entry.vault.baseAsset, entry.vault.vaultId),
      shareMint: entry.vault.shareMint,
      baseAsset: entry.vault.baseAsset,
      baseAssetSymbol: WELL_KNOWN_TOKEN_BY_MINT.get(entry.vault.baseAsset)?.symbol ?? null,
      shareDecimals: entry.vault.shareDecimals,
      accountingPaused: entry.vault.accountingPaused,
      tellerPaused: entry.vault.tellerPaused,
      complianceMode: entry.vault.complianceMode,
      withdrawAuthority:
        entry.vault.withdrawAuthority === VEDA_UNSET_AUTHORITY
          ? null
          : entry.vault.withdrawAuthority,
      lockDurationSeconds: entry.vault.lockDurationSeconds.toString(),
      platformFeeBps: entry.vault.platformFeeBps,
      performanceFeeBps: entry.vault.performanceFeeBps,
      assets,
      outcome: depositMints.length > 0 ? "catalogued" : "dropped",
      dropReason: depositMints.length > 0 ? null : "no_declared_deposit_asset",
      depositMints,
      liquidityTerm: liquidity.liquidityTerm,
      redemptionDelayDays: liquidity.redemptionDelayDays ?? null,
    };
  });

  return {
    cluster,
    skipped: null,
    configuredVaults: deployment.vaultStateAddresses.length,
    rows,
  };
}

function renderVaultTable(rows: readonly VaultRow[]): string {
  if (rows.length === 0) return "_No vaults read._\n";
  const lines = [
    "| Vault | Name | Base | Shelf | Deposit assets | Liquidity | Fees (platform/perf) | Flags |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => {
      const flags = [
        row.accountingPaused ? "accounting paused" : null,
        row.tellerPaused ? "teller paused" : null,
        row.complianceMode ? "compliance mode" : null,
        row.withdrawAuthority ? "restricted redemption" : null,
      ]
        .filter(Boolean)
        .join(", ");
      const assets =
        row.depositMints
          .map((mint) => WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol ?? mint)
          .join(", ") || "—";
      const liquidity =
        row.redemptionDelayDays === null
          ? row.liquidityTerm
          : `${row.liquidityTerm} (${row.redemptionDelayDays}d)`;
      return `| \`${row.address}\` | ${row.name} | ${row.baseAssetSymbol ?? "—"} | ${
        row.outcome
      } | ${assets} | ${liquidity} | ${row.platformFeeBps} / ${row.performanceFeeBps} bps | ${
        flags || "—"
      } |`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

function renderAssetTable(rows: readonly VaultRow[]): string {
  const assets = rows.flatMap((row) =>
    row.assets.map((asset) => ({ vault: row.address, ...asset }))
  );
  if (assets.length === 0) return "_No asset configuration read._\n";
  const lines = [
    "| Vault | Asset | Deposits | Withdrawals | SDP fronts it |",
    "|---|---|---|---|---|",
    ...assets.map(
      (asset) =>
        `| \`${asset.vault}\` | ${asset.symbol ?? `\`${asset.mint}\``} | ${
          asset.allowDeposits ? "yes" : "no"
        } | ${asset.allowWithdrawals ? "yes" : "no"} | ${asset.admitted ? "yes" : "no"} |`
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function renderCluster(cluster: ClusterInventory): string {
  if (cluster.skipped) {
    return `### ${cluster.cluster}\n\n_Not read: ${cluster.skipped}._\n`;
  }
  const catalogued = cluster.rows.filter((row) => row.outcome === "catalogued").length;
  return `### ${cluster.cluster}

- Vaults configured: **${cluster.configuredVaults}**
- Catalogued by SDP: **${catalogued}**

${renderVaultTable(cluster.rows)}
#### Asset configuration, as the vault declares it

${renderAssetTable(cluster.rows)}`;
}

function renderReport(inventory: Inventory): string {
  const read = inventory.clusters.filter((cluster) => cluster.skipped === null);
  const configured = inventory.clusters.reduce(
    (total, cluster) => total + cluster.configuredVaults,
    0
  );

  return `# Veda catalogue inventory

<!-- Generated by apps/sdp-api/scripts/inventory-veda-catalogue.ts — do not edit by hand. -->

Veda's shelf is an explicit ALLOWLIST, not a census. Its vaults are deployed per
customer under one program, so enumerating that program's accounts would put
other integrators' vaults on SDP's shelf; the addresses come from
\`VEDA_DEPLOYMENTS\` in \`@sdp/types/veda-programs\` and carry only what Veda
confirmed. This report is what the chain says about each of them, and what that
turned into.

**Every row is \`defi\`, and no row carries a curator.** A Veda vault reaches
strategies through pre-approved CPI digests, so what it might hold is not what
its state establishes — and \`rwa\` is the one classification an integrator
filters on to find real-world backing. Both fields return when Veda publishes
something that establishes them.

**No row carries an APY.** One reading of an exchange rate is not a rate of
return, so the catalogue reports none and the dashboard renders "—" rather than
a fabricated figure.

- Fetched: \`${inventory.fetchedAt}\`
- Declared deposit tokens: **${inventory.declaredDepositTokens.join(", ")}** (\`VEDA_DEPOSIT_TOKEN_SYMBOLS\`)
- Vaults configured across clusters: **${configured}**
- Clusters read: **${read.length} of ${inventory.clusters.length}**

## What each column decides

- **Shelf** — \`catalogued\` when the vault enables at least one deposit asset
  SDP declares; \`dropped\` otherwise. A drop is not an error: it is a vault this
  deployment has nothing to offer for.
- **Liquidity** — \`instant\` only when redemption is permissionless AND shares
  are unlocked. Either constraint reports \`delayed\`, with the lock rounded UP to
  whole days.
- **Flags** — read straight off vault state. \`compliance mode\` means deposits
  need an approval SDP does not implement, so a build refuses;
  \`restricted redemption\` means a named authority must sign an exit.

## Clusters

${inventory.clusters.map(renderCluster).join("\n")}`;
}

async function runFetch(): Promise<void> {
  const clusters: ClusterInventory[] = [];
  for (const cluster of SOLANA_CLUSTERS) {
    clusters.push(await inventoryCluster(cluster));
  }

  const inventory: Inventory = {
    fetchedAt: new Date().toISOString(),
    declaredDepositTokens: [...VEDA_DEPOSIT_TOKEN_SYMBOLS],
    clusters,
  };

  // Validate BEFORE writing, not just when reading back: everything above came
  // off the chain and this file is committed, so a malformed or unbounded field
  // fails the script here rather than landing in the repo.
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
      `No snapshot at ${path.relative(process.cwd(), INVENTORY_FILE)} — run \`pnpm --filter @sdp/api earn:inventory:veda\` first.`
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
