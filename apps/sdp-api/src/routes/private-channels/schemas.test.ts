import { describe, expect, it } from "vitest";
import {
  createDepositBodySchema,
  createTransferBodySchema,
  createWithdrawalBodySchema,
} from "./schemas";

// The three write bodies, tested together because the point is that they agree.
// Deposit and withdrawal previously accepted `amount` as a bare non-empty string,
// so a malformed or over-scaled value reached `parseDecimalAmount` in the service,
// threw an `AmountError`, and surfaced as a 500 — `mapPrivateChannelError` has no
// case for it. They now share transfer's amount schema, which rejects at the route.

const WRITE_BODY_SCHEMAS = [
  ["deposit", createDepositBodySchema] as const,
  ["withdrawal", createWithdrawalBodySchema] as const,
  ["transfer", createTransferBodySchema] as const,
];

/** Minimal valid body per schema; transfer alone requires a recipient. */
function bodyFor(name: string, overrides: Record<string, unknown>) {
  return {
    walletId: "wlt_1",
    amount: "1.5",
    ...(name === "transfer" ? { recipientVerifiedWalletId: "pcvw_1" } : {}),
    ...overrides,
  };
}

describe("private-channel write body schemas", () => {
  for (const [name, schema] of WRITE_BODY_SCHEMAS) {
    describe(name, () => {
      it("rejects a malformed or over-scaled amount at the route boundary", () => {
        // Each of these used to reach the service and become a 500 on deposit and
        // withdrawal. Six decimals is the scale of the only allowlisted token.
        for (const amount of ["not-a-decimal", "0", "-1", "1.0000001", ""]) {
          expect(schema.safeParse(bodyFor(name, { amount })).success, amount).toBe(false);
        }
      });

      it("accepts amounts within that scale", () => {
        for (const amount of [".5", "1", "1.000001"]) {
          expect(schema.safeParse(bodyFor(name, { amount })).success, amount).toBe(true);
        }
      });

      it("treats mint as optional so an omitted token falls back to the instance default", () => {
        const parsed = schema.safeParse(bodyFor(name, {}));
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.mint).toBeUndefined();
      });

      it("carries a supplied mint through for the service to validate", () => {
        // The schema deliberately does NOT check the allowlist — that needs the
        // instance's cluster, which only the service has. It just has to not drop
        // the field, or a selected token would silently become the default.
        const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
        const parsed = schema.safeParse(bodyFor(name, { mint }));
        expect(parsed.success && parsed.data.mint).toBe(mint);
      });
    });
  }
});
