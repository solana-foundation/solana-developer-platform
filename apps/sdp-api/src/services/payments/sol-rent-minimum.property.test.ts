import { runInClusterScope } from "@sdp/rpc/scope";
import * as solanaRpc from "@sdp/rpc/solana";
import { type Address, address } from "@solana/kit";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  installClusterRpcStub,
  STUB_SYSTEM_ACCOUNT_RENT_MINIMUM,
} from "@/test/helpers/cluster-rpc";
import { propertyParameters } from "@/test/helpers/property";
import { findSolRentShortfall, type SolMovement } from "./sol-rent-minimum";

/**
 * Property tests (STRIDE P5.4) for the native SOL rent check (HOO-2375): its
 * verdict on the source wallet must match a brute-force model of the chain,
 * which refuses any transaction that leaves the sender holding more than
 * nothing but less than the rent-exempt minimum. Concurrent transactions
 * land in any order, so the model checks the sender after every non-empty
 * subset of them has landed.
 */

const MINIMUM = BigInt(STUB_SYSTEM_ACCOUNT_RENT_MINIMUM);
const SOURCE = address(TEST_SOLANA_ADDRESSES.wallet1);
const OTHERS = [address(TEST_SOLANA_ADDRESSES.wallet2), address(TEST_SOLANA_ADDRESSES.wallet3)];
const getMultipleAccountsLamportsMock = vi.spyOn(solanaRpc, "getMultipleAccountsLamports");

/** Lamports near the minimum, where the check decides, and far from it. */
const lamportsArb = fc.oneof(
  fc.bigInt({ min: 1n, max: 3n * MINIMUM }),
  fc.constantFrom(1n, MINIMUM - 1n, MINIMUM, MINIMUM + 1n),
  fc.bigInt({ min: 1n, max: 10n ** 12n })
);

const movementArb = fc
  .record({
    payments: fc.array(
      fc.record({
        // Mostly other wallets; sometimes a payment back to the source.
        destination: fc.oneof(
          { weight: 4, arbitrary: fc.constantFrom(...OTHERS) },
          { weight: 1, arbitrary: fc.constant(SOURCE) }
        ),
        lamports: lamportsArb,
      }),
      { minLength: 1, maxLength: 8 }
    ),
    transactionCount: fc.integer({ min: 1, max: 4 }),
  })
  .chain(({ payments, transactionCount }) =>
    fc.record({
      payments: fc.constant(payments.map((payment, index) => ({ ...payment, index }))),
      // Payments assigned to transactions in order, as the batch chunker does.
      cuts: fc.uniqueArray(fc.integer({ min: 1, max: Math.max(1, payments.length - 1) }), {
        maxLength: Math.min(transactionCount - 1, payments.length - 1),
      }),
      sourceLamports: fc.oneof(
        fc.constant(
          payments.reduce((sum, p) => (p.destination === SOURCE ? sum : sum + p.lamports), 0n)
        ),
        fc.bigInt({ min: 0n, max: 10n ** 13n })
      ),
      destinationFunded: fc.boolean(),
    })
  )
  .map(({ payments, cuts, sourceLamports, destinationFunded }) => {
    const bounds = [0, ...[...cuts].sort((a, b) => a - b), payments.length];
    const transactions = bounds
      .slice(1)
      .map((end, position) => payments.slice(bounds[position], end).map((p) => p.index))
      .filter((indexes) => indexes.length > 0);
    const movement: SolMovement = {
      source: SOURCE,
      payments,
      ...(transactions.length > 1 ? { transactions } : {}),
    };
    return { movement, sourceLamports, destinationFunded };
  });

/** The lamports each transaction moves out of the source. */
function transactionOutflows(movement: SolMovement): bigint[] {
  const outflow = (index: number) => {
    const payment = movement.payments.find((p) => p.index === index);
    if (payment === undefined) throw new Error(`unknown payment ${index}`);
    return payment.destination === movement.source ? 0n : payment.lamports;
  };
  const transactions = movement.transactions ?? [movement.payments.map((p) => p.index)];
  return transactions.map((indexes) => indexes.reduce((sum, i) => sum + outflow(i), 0n));
}

/** Whether some order of landing leaves the sender in the (0, minimum) band. */
function modelSourceRefused(movement: SolMovement, balance: bigint): boolean {
  const sent = transactionOutflows(movement);
  const total = sent.reduce((sum, lamports) => sum + lamports, 0n);
  // Underfunded movements are the funding check's to refuse, not the rent check's.
  if (balance < total) return false;
  for (let landed = 1; landed < 1 << sent.length; landed++) {
    const held = sent.reduce(
      (remaining, lamports, position) =>
        landed & (1 << position) ? remaining - lamports : remaining,
      balance
    );
    if (held > 0n && held < MINIMUM) return true;
  }
  return false;
}

function find(movement: SolMovement, sourceLamports: bigint, destinationFunded: boolean) {
  getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
    addresses.map((account: Address) =>
      account === SOURCE ? sourceLamports : destinationFunded ? MINIMUM : 0n
    )
  );
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    findSolRentShortfall(movement)
  );
}

describe("findSolRentShortfall (property)", () => {
  installClusterRpcStub();

  beforeEach(() => {
    getMultipleAccountsLamportsMock.mockReset();
  });

  it("refuses the source exactly when some landing order leaves it below the minimum", async () => {
    await fc.assert(
      fc.asyncProperty(movementArb, async ({ movement, sourceLamports, destinationFunded }) => {
        const shortfall = await find(movement, sourceLamports, destinationFunded);
        const refused = shortfall?.sourceRemainderLamports != null;
        const modelRefused = modelSourceRefused(movement, sourceLamports);
        // Sound: never admits a movement the chain would refuse.
        if (modelRefused) expect(refused).toBe(true);
        // Exact, except where a transaction carries only payments back to the
        // source: the check counts its 0 lamports out as a sweep transaction
        // below the minimum and refuses a sweep the chain would accept (PRO-2321).
        const movesNothingOut = transactionOutflows(movement).some((sent) => sent === 0n);
        if (!movesNothingOut) expect(refused).toBe(modelRefused);
        if (refused) {
          const remainder = shortfall?.sourceRemainderLamports ?? -1n;
          expect(remainder >= 0n && remainder < MINIMUM).toBe(true);
        }
      }),
      propertyParameters()
    );
  });

  it("refuses exactly the payments below the minimum to an address with no account", async () => {
    await fc.assert(
      fc.asyncProperty(movementArb, async ({ movement, sourceLamports, destinationFunded }) => {
        const shortfall = await find(movement, sourceLamports, destinationFunded);
        const expected = movement.payments
          .filter((payment) => payment.lamports < MINIMUM)
          .filter(
            (payment) =>
              (payment.destination === SOURCE
                ? sourceLamports
                : destinationFunded
                  ? MINIMUM
                  : 0n) === 0n
          )
          .map((payment) => payment.index);
        expect(shortfall?.recipientIndexes ?? []).toEqual(expected);
      }),
      propertyParameters()
    );
  });
});
