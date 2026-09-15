import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
  type UnifiedTransactionStatus,
} from "@sdp/types";
import { UNIFIED_TRANSACTION_SOURCES } from "../src/db/unified-transactions/sources";

const TARGET = path.resolve(
  process.cwd(),
  "src/db/migrations/postgres/repeatable/unified_transactions.sql"
);

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function statusCase(module: UnifiedTransactionModule): string {
  const mappings = Object.entries(UNIFIED_TRANSACTION_MODULE_CONTRACTS[module].status);
  return `CASE module_status\n${mappings
    .map(([moduleStatus, status]) => `    WHEN ${quote(moduleStatus)} THEN ${quote(status)}`)
    .join("\n")}\n  END`;
}

function sourceSql(module: UnifiedTransactionModule): string {
  const source = UNIFIED_TRANSACTION_SOURCES[module];
  const contract = UNIFIED_TRANSACTION_MODULE_CONTRACTS[module];
  const statusOf: Readonly<Record<string, UnifiedTransactionStatus>> = contract.status;
  return source.sql({
    moduleStatusesOf: (status) =>
      contract.moduleStatuses
        .filter((moduleStatus) => statusOf[moduleStatus] === status)
        .map((moduleStatus) => quote(moduleStatus)),
  });
}

export function renderUnifiedTransactionsView(): string {
  const branches = UNIFIED_TRANSACTION_MODULES.map(
    (module) => `SELECT
  id,
  module_id,
  kind,
  module_status,
  organization_id,
  project_id,
  custody_wallet_id,
  token,
  amount,
  counterparty_id,
  signature,
  created_at,
  ${quote(module)} AS module,
  ${statusCase(module)} AS status
FROM (
${sourceSql(module)}
) ${module}`
  );
  return `DROP VIEW IF EXISTS unified_transactions;
CREATE VIEW unified_transactions WITH (security_invoker = true) AS
SELECT
  unified.id,
  unified.module_id,
  unified.kind,
  unified.module_status,
  unified.organization_id,
  unified.project_id,
  unified.custody_wallet_id,
  cw.label AS custody_wallet_label,
  unified.token,
  unified.amount,
  unified.counterparty_id,
  unified.signature,
  unified.created_at,
  unified.module,
  unified.status
FROM (
${branches.join("\nUNION ALL\n")}
) unified
LEFT JOIN custody_wallets cw ON cw.id = unified.custody_wallet_id;
`;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const rendered = renderUnifiedTransactionsView();
  switch (command) {
    case "generate":
      await writeFile(TARGET, rendered);
      break;
    case "drift": {
      const current = await readFile(TARGET, "utf8");
      if (current !== rendered) {
        console.error("Unified transactions view drift detected.");
        process.exitCode = 1;
      }
      break;
    }
    default:
      throw new Error("Usage: unified-transactions-view.ts <generate|drift>");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
