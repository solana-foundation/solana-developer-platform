import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR 0002 pluggability gate: the withdrawal ledger consumes only the
 * canonical provider contract, so its module must never name a concrete
 * provider — a new provider inherits the entire ledger with zero code here.
 * (The behavioral half of this proof is the ledger repo/service suite in
 * db/repositories/earn.repository.test.ts, which runs against a non-Ground
 * stub id.)
 */
describe("earn withdrawal ledger — provider neutrality", () => {
  it("never names a concrete provider in the ledger service module", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./earn-withdrawal-ledger.service.ts", import.meta.url)),
      "utf8"
    );
    for (const providerId of ["ground", "veda", "upshift", "perena"]) {
      expect(source.toLowerCase()).not.toContain(providerId);
    }
  });
});
