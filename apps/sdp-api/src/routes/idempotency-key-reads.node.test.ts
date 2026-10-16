import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ratchet on hand-rolled Idempotency-Key handling (HOO-1918, ADR 0009).
 *
 * The shared step (`middleware/idempotency.ts`) owns the header. Modules still
 * on their own handling read it directly; this pins how often, per file. The
 * counts may only go down: a module drops its reads when it moves onto the
 * shared step at promotion, and a new direct read fails here. Lower a count in
 * the same change that removes a read.
 */
const PINNED_READS: Record<string, number> = {
  // Reads the key for the domain-row replay; goes when requestGate's last user moves off it.
  "middleware/request-gate.ts": 1,
  "routes/dvp/handlers.ts": 4,
  "routes/earn/handlers/external-wallet.ts": 1,
  "routes/earn/handlers/program.ts": 1,
  "routes/earn/handlers/queued-withdrawals.ts": 2,
  "routes/earn/handlers/vault.ts": 2,
  "routes/internal-custody/index.ts": 3,
  "routes/issuance/handlers/authority.ts": 2,
  "routes/issuance/handlers/burn.ts": 2,
  "routes/issuance/handlers/deploy.ts": 1,
  "routes/issuance/handlers/force-burn.ts": 2,
  "routes/issuance/handlers/freeze.ts": 4,
  "routes/issuance/handlers/mint.ts": 2,
  "routes/issuance/handlers/pause.ts": 4,
  "routes/issuance/handlers/seize.ts": 2,
  // Payments (transfers, batches, recurring) reads none: its rows take the key from
  // getIdempotencyClaim, and its access checks never depend on whether one was sent.
  "routes/private-channels/helpers.ts": 1,
};

const SHARED_STEP = new Set([
  "middleware/idempotency.ts",
  "middleware/idempotency-key.ts",
  "middleware/movement-steps.ts",
]);
const HEADER_READ =
  /header\??\.?\(\s*(?:"Idempotency-Key"|"idempotency-key"|IDEMPOTENCY_KEY_HEADER)\s*\)|\.get\(\s*(?:"Idempotency-Key"|"idempotency-key"|IDEMPOTENCY_KEY_HEADER)\s*\)|\bparseIdempotencyKey\(/g;

function sourceFiles(dir: string, root: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full, root);
    const relative = path.relative(root, full);
    return relative.endsWith(".ts") && !/\.test\.ts$/.test(relative) ? [relative] : [];
  });
}

describe("Idempotency-Key header reads", () => {
  it("only shrinks outside the shared step", () => {
    const root = path.resolve(__dirname, "..");
    const counts: Record<string, number> = {};
    for (const file of sourceFiles(root, root)) {
      if (SHARED_STEP.has(file)) continue;
      const reads = readFileSync(path.join(root, file), "utf8").match(HEADER_READ)?.length ?? 0;
      if (reads > 0) counts[file] = reads;
    }
    expect(counts).toEqual(PINNED_READS);
  });
});
