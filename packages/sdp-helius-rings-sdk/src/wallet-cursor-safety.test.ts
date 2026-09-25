import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type { SyncReport } from "@heliuslabs/zolana/transaction";
import type { SyncClient } from "@heliuslabs/zolana/wallet";
import { afterEach, describe, expect, it } from "vitest";
import { readKeys } from "./keys.js";
import { canonicalShieldedIdentity } from "./material.js";
import { TEST_REQUEST, testMaterialSource } from "./test/shielded-identity-fixtures.js";
import { committedPastIncompleteData, hydrateWallet } from "./wallet.js";
import { clearWalletCache, getCachedWallet } from "./wallet-cache.js";

/**
 * Cursor-safety of the shared wallet cache.
 *
 * Zolana's sync commits its per-tag cursors even when the report carries
 * `unparsedTransactions` or `undecryptableCandidates`: the events the indexer
 * could not serve are never stored, and the committed cursors resume past them.
 * When the synced `Wallet` is the one cached for the identity (wallet-cache.ts),
 * every later hydration — reporting or spend — inherits the advanced cursors and
 * the skipped event is never revisited. A strict spend then validates a history
 * that is silently missing a note.
 *
 * These tests run the real `syncWallet` against a `SyncClient` stand-in whose
 * cursor semantics match the indexer contract: a request resumes strictly past
 * the cursor it was given, and `scannedThrough` is the position the page read
 * to. A transaction is modelled that appears (momentarily unparseable) while the
 * strict spend syncs, and is served in parseable form once the indexer
 * recovers. Nothing about the wallet or sync modules is mocked.
 */

const context = { blockTime: 0n, slot: 0n };

/** The transaction's identity fields; the output slots carry the difference. */
const EVENT_BASE = {
  slot: 42n,
  txSignature: "1111111111111111111111111111111111111111111111111111111111111111",
  messages: [],
  nullifiers: [],
  proofless: false,
};

/** An indexed transaction with no classifiable output: counted as unparsed. */
const UNPARSEABLE_EVENT = { ...EVENT_BASE, outputSlots: [] } as never;

/**
 * The same event once the indexer can serve it. One output slot classifies it,
 * so it is no longer counted; its view tag belongs to nobody, so it stores no
 * note and raises no undecryptable candidate.
 */
const RECOVERED_EVENT = {
  ...EVENT_BASE,
  outputSlots: [
    {
      outputContext: {
        tree: "Tree1111111111111111111111111111111111111111",
        leafIndex: 0n,
        hash: new Uint8Array(32).fill(3),
      },
      viewTag: new Uint8Array(32).fill(9),
    },
  ],
} as never;

const EVENT_POSITION = 2;

interface IndexerScript {
  /** Whether the event is currently served without its output slots. */
  corrupt: boolean;
  /** The highest position present in the index. */
  indexedThrough: number;
}

/**
 * A SyncClient over one event at position 2. The transactions stream is logged
 * as the exact cursors the real sync supplied, so the test can see where each
 * sync resumed.
 */
function indexer(script: IndexerScript, transactionCursors: string[]): SyncClient {
  const cursorPosition = (cursor: Uint8Array | undefined): number =>
    cursor === undefined ? 0 : (cursor[0] ?? 0);
  const client: SyncClient = {
    getShieldedTransactionsByTags: async (request) => {
      const from = cursorPosition(request.cursor);
      transactionCursors.push(from === 0 ? "<start>" : String(from));
      const served =
        script.indexedThrough >= EVENT_POSITION && from < EVENT_POSITION
          ? [script.corrupt ? UNPARSEABLE_EVENT : RECOVERED_EVENT]
          : [];
      return {
        context,
        transactions: served,
        scannedThrough: Uint8Array.of(Math.max(from, script.indexedThrough)),
      };
    },
    getEncryptedUtxosByTags: async (request) => ({
      context,
      matches: [],
      scannedThrough: Uint8Array.of(
        Math.max(cursorPosition(request.cursor), script.indexedThrough)
      ),
    }),
    getShieldedTransactionsByNullifiers: async (request) => ({
      context,
      transactions: [],
      ...(request.cursor === undefined ? {} : { scannedThrough: request.cursor }),
    }),
  };
  return client;
}

afterEach(() => clearWalletCache());

describe("wallet hydration cursor safety", () => {
  it("re-scans the skipped range after a strict spend rejects an incomplete sync", async () => {
    const transactionCursors: string[] = [];
    const script: IndexerScript = { corrupt: false, indexedThrough: 1 };
    const runtimeClient = indexer(script, transactionCursors) as unknown as ZolanaClient;

    await testMaterialSource().withMaterial(TEST_REQUEST, async (material) => {
      const read = readKeys(material);
      try {
        // Warm the shared cache the way a dashboard read does: clean scan,
        // cursors committed at position 1.
        const initial = await hydrateWallet({
          walletId: TEST_REQUEST.walletId,
          client: runtimeClient,
          keys: read,
          requireComplete: false,
        });
        expect(initial.report.unparsedTransactions).toBe(0);
        expect(
          getCachedWallet(
            TEST_REQUEST.walletId,
            canonicalShieldedIdentity(material.shieldedAddress)
          )
        ).toBe(initial.wallet);
      } finally {
        read.destroy();
      }

      // The event lands mid-index while a spend syncs: served without output
      // slots, so the report counts it and the strict path must refuse.
      script.corrupt = true;
      script.indexedThrough = EVENT_POSITION;

      const strictKeys = readKeys(material);
      try {
        await expect(
          hydrateWallet({
            walletId: TEST_REQUEST.walletId,
            client: runtimeClient,
            keys: strictKeys,
            requireComplete: true,
          })
        ).rejects.toMatchObject({ code: "gateway_unavailable" });
      } finally {
        strictKeys.destroy();
      }

      // The refused sync must not leave the cache holding a wallet whose
      // cursors already resumed past the unparseable event.
      expect(
        getCachedWallet(TEST_REQUEST.walletId, canonicalShieldedIdentity(material.shieldedAddress))
      ).toBeUndefined();

      // The indexer recovers; the next reporting read gets the event back.
      script.corrupt = false;
      const recoveredKeys = readKeys(material);
      try {
        const recovered = await hydrateWallet({
          walletId: TEST_REQUEST.walletId,
          client: runtimeClient,
          keys: recoveredKeys,
          requireComplete: false,
        });
        expect(recovered.report.unparsedTransactions).toBe(0);
      } finally {
        recoveredKeys.destroy();
      }
    });

    // The recovery scan re-queried from the start, not from the cursors the
    // failed strict sync committed past the incomplete range.
    expect(transactionCursors).toEqual(["<start>", "1", "<start>"]);
  });

  it("never leaves a degraded reporting scan advanced where a strict spend would resume", async () => {
    const transactionCursors: string[] = [];
    const script: IndexerScript = { corrupt: true, indexedThrough: EVENT_POSITION };
    const runtimeClient = indexer(script, transactionCursors) as unknown as ZolanaClient;

    await testMaterialSource().withMaterial(TEST_REQUEST, async (material) => {
      // Reporting tolerates the incomplete read and says so.
      const degradedKeys = readKeys(material);
      let degraded: Awaited<ReturnType<typeof hydrateWallet>>;
      try {
        degraded = await hydrateWallet({
          walletId: TEST_REQUEST.walletId,
          client: runtimeClient,
          keys: degradedKeys,
          requireComplete: false,
        });
      } finally {
        degradedKeys.destroy();
      }
      expect(degraded.report.unparsedTransactions).toBe(1);
      expect(degraded.report.undecryptableCandidates).toBe(0);

      // But the degraded scan must not stay cached: its cursors ran past an
      // event no later sync would revisit.
      expect(
        getCachedWallet(TEST_REQUEST.walletId, canonicalShieldedIdentity(material.shieldedAddress))
      ).toBeUndefined();

      // The next spend re-scans the same incomplete range and is refused too,
      // instead of validating the truncated history as complete.
      const strictKeys = readKeys(material);
      try {
        await expect(
          hydrateWallet({
            walletId: TEST_REQUEST.walletId,
            client: runtimeClient,
            keys: strictKeys,
            requireComplete: true,
          })
        ).rejects.toMatchObject({ code: "gateway_unavailable" });
      } finally {
        strictKeys.destroy();
      }
    });

    // Both scans started from the beginning: the strict spend re-read the
    // range the degraded reporting scan had already committed through.
    expect(transactionCursors).toEqual(["<start>", "<start>"]);
  });

  it("treats every cursor-skipping anomaly count as commit-blocking", () => {
    const clean: SyncReport = {
      storedUtxos: 0,
      unparsedTransactions: 0,
      undecryptableCandidates: 0,
      unknownAssetIds: [],
      unknownAssetFields: [],
    };

    expect(committedPastIncompleteData(clean)).toBe(false);
    expect(committedPastIncompleteData({ ...clean, unparsedTransactions: 1 })).toBe(true);
    expect(committedPastIncompleteData({ ...clean, undecryptableCandidates: 2 })).toBe(true);
    // Unknown assets never reach a commit upstream: an unresolved asset throws
    // before the session seals, so alone they do not distrust the cursors.
    expect(committedPastIncompleteData({ ...clean, unknownAssetIds: [9n] })).toBe(false);
    expect(
      committedPastIncompleteData({
        ...clean,
        unknownAssetFields: [new Uint8Array(32).fill(1) as never],
      })
    ).toBe(false);
  });
});
