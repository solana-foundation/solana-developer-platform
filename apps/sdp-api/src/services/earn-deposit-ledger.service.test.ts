import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static gates on the deposit ledger (PRO-1669). The BEHAVIOURAL half of both
 * proofs is the ledger suite in `db/repositories/earn.repository.test.ts`, which
 * runs against a non-Ground stub id and drives every applier path.
 *
 * These two properties are the ones a future change is most likely to break while
 * every behavioural test still passes, because breaking them looks like a local
 * convenience at the call site.
 */

const MODULES = {
  "the ledger service": "./earn-deposit-ledger.service.ts",
  "the sweep": "../cron/earn-deposit-sweep.ts",
} as const;

function readModule(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/**
 * Comments are stripped for the code-shape assertions below, because the module
 * headers deliberately QUOTE the anti-patterns they forbid ("if you find yourself
 * writing `observation.source === …`") and a gate that cannot tell prose from code
 * would force those warnings to be deleted to stay green.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("earn deposit ledger — provider neutrality", () => {
  // ADR 0002 pluggability: both modules consume only the canonical provider
  // contract, so a new provider inherits the deposit ledger AND its sweep with
  // zero code in either — which is only true while neither names one.
  for (const [label, path] of Object.entries(MODULES)) {
    it(`never names a concrete provider in ${label}`, () => {
      const source = readModule(path).toLowerCase();
      for (const providerId of ["ground", "veda", "upshift", "perena"]) {
        // Word-bounded, NOT a bare substring: `BackgroundRunner` contains "ground"
        // and `observedAt` contains "veda", so a substring check fails on
        // completely provider-neutral code. Every real violation
        // (`=== "ground"`, `EARN_PROVIDER_CLIENTS.ground`, `provider: "veda"`)
        // still has a non-word character before the id, so the boundary keeps the
        // gate strict where it matters.
        expect(source).not.toMatch(new RegExp(`\\b${providerId}\\b`));
      }
    });
  }
});

describe("earn deposit ledger — observation-source neutrality", () => {
  /**
   * The product direction this ticket exists to serve: provider polling is the
   * INTERIM observer, provider webhooks (PRO-1631) are next, and an SDP indexer
   * reading chain directly is the desired end state. All three write the same row
   * through the same applier, which only stays true while the transition logic
   * never asks WHO observed.
   *
   * Per-source difference belongs in the adapter that BUILDS an observation
   * (`depositObservationFromProviderRead`, or the indexer's own emitter) — never in
   * the machine that applies it. A `switch` on the source inside the applier would
   * make adding the indexer a rewrite of the state machine instead of a new writer.
   */
  it("never branches on the observation source in the ledger service", () => {
    const code = stripComments(readModule(MODULES["the ledger service"]));

    // The adapter's parameter narrowing is a TYPE-level constraint (an `Extract<>`),
    // so these target runtime comparisons only.
    expect(code).not.toMatch(/switch\s*\(\s*\w*\.?source/);
    expect(code).not.toMatch(/\.source\s*===/);
    expect(code).not.toMatch(/===\s*["'](provider_poll|provider_webhook|chain_indexer)["']/);
  });

  it("never branches on the observation source in the sweep", () => {
    // The sweep is allowed to NAME its own source when it builds an observation —
    // it is an observer — but it must not branch on one, which would mean it knows
    // something about how the ledger treats sources.
    const code = stripComments(readModule(MODULES["the sweep"]));

    expect(code).not.toMatch(/switch\s*\(\s*\w*\.?source/);
    expect(code).not.toMatch(/\.source\s*===/);
  });
});
