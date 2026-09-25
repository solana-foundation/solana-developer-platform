import { type Bytes32, initializePoseidon } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type { SyncReport } from "@heliuslabs/zolana/transaction";
import { EncryptedScheme, SOL_MINT, Utxo } from "@heliuslabs/zolana/transaction";
import type { SyncClient } from "@heliuslabs/zolana/wallet";
import { afterEach, describe, expect, it } from "vitest";
import { readKeys } from "./keys.js";
import { canonicalShieldedIdentity, type ShieldedMaterial } from "./material.js";
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
 * to. A deposit is modelled that appears (momentarily stripped of its outputs)
 * while the strict spend syncs, and is served in parseable form once the
 * indexer recovers — addressed to the identity, so the replay must restore its
 * note, not merely return a clean report. Nothing about the wallet or sync
 * modules is mocked.
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

const DEPOSIT_BLINDING = new Uint8Array(32).fill(5) as Bytes32;
const DEPOSIT_AMOUNT = 1_000n;

/**
 * The event in its owned, recovered form: a proofless deposit on the
 * encrypted-utxo stream. The payload is the wire form the sync parses — owner,
 * blinding, asset, amount, then six absent optionals — and the committed output
 * hash is the one the wallet recomputes from the note, so the slot is accepted
 * rather than counted as an undecryptable candidate. The deposit rail forces
 * the note's owner to the wallet reading it (the payload's owner field is
 * filler) and the zeroed asset field is SOL, the registry's built-in. The view
 * tag is the identity's confidential tag, so this wallet — and only this
 * wallet — opens the slot and stores the note.
 */
async function ownedDeposit(material: ShieldedMaterial) {
  await initializePoseidon();
  const body = new Uint8Array(32 + 32 + 32 + 8 + 6);
  body.set(new Uint8Array(32).fill(1), 0);
  body.set(DEPOSIT_BLINDING, 32);
  // The asset field is left zeroed and the six optional fields stay absent.
  new DataView(body.buffer).setBigUint64(96, DEPOSIT_AMOUNT, true);
  const payload = new Uint8Array(1 + 4 + 1 + body.length);
  payload[0] = 0x00; // plaintext encoding tag
  // The length covers the scheme byte that prefixes the body.
  new DataView(payload.buffer).setUint32(1, body.length + 1, true);
  payload[5] = EncryptedScheme.proofless;
  payload.set(body, 6);
  const note = new Utxo({
    owner: material.shieldedAddress.signingPublicKey,
    asset: SOL_MINT,
    amount: DEPOSIT_AMOUNT,
    blinding: DEPOSIT_BLINDING,
  });
  return {
    slot: EVENT_BASE.slot,
    txSignature: EVENT_BASE.txSignature,
    outputSlot: {
      outputContext: {
        tree: "Tree1111111111111111111111111111111111111111",
        leafIndex: 0n,
        hash: note.hash(material.shieldedAddress.nullifierPublicKey),
      },
      viewTag: material.shieldedAddress.signingPublicKey.confidentialViewTag(),
      payload,
    },
  };
}

const EVENT_POSITION = 2;

interface IndexerScript {
  /** Whether the event is currently served without its output slots. */
  corrupt: boolean;
  /** The highest position present in the index. */
  indexedThrough: number;
}

/**
 * A SyncClient over one event at position 2. While the indexer is corrupt the
 * event is served on the transactions stream stripped of its outputs; once it
 * recovers, the event surfaces as the owned deposit on the encrypted-utxo
 * stream. The transactions stream is logged as the exact cursors the real sync
 * supplied, so the test can see where each sync resumed.
 */
async function indexer(
  script: IndexerScript,
  transactionCursors: string[],
  material: ShieldedMaterial
): Promise<SyncClient> {
  const deposit = await ownedDeposit(material);
  const cursorPosition = (cursor: Uint8Array | undefined): number =>
    cursor === undefined ? 0 : (cursor[0] ?? 0);
  const client: SyncClient = {
    getShieldedTransactionsByTags: async (request) => {
      const from = cursorPosition(request.cursor);
      transactionCursors.push(from === 0 ? "<start>" : String(from));
      const served =
        script.corrupt && script.indexedThrough >= EVENT_POSITION && from < EVENT_POSITION
          ? [UNPARSEABLE_EVENT]
          : [];
      return {
        context,
        transactions: served,
        scannedThrough: Uint8Array.of(Math.max(from, script.indexedThrough)),
      };
    },
    getEncryptedUtxosByTags: async (request) => {
      const from = cursorPosition(request.cursor);
      return {
        context,
        matches:
          !script.corrupt && script.indexedThrough >= EVENT_POSITION && from < EVENT_POSITION
            ? [deposit as never]
            : [],
        scannedThrough: Uint8Array.of(Math.max(from, script.indexedThrough)),
      };
    },
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

    await testMaterialSource().withMaterial(TEST_REQUEST, async (material) => {
      const runtimeClient = (await indexer(
        script,
        transactionCursors,
        material
      )) as unknown as ZolanaClient;

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

      // The indexer recovers; the next reporting read gets the event back and
      // must restore the note it carries — a replay that silently dropped the
      // owned output would look exactly like a clean empty scan otherwise.
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
        const notes = recovered.wallet.utxos();
        expect(notes).toHaveLength(1);
        expect(notes[0]?.spent).toBe(false);
        expect(notes[0]?.utxo.asset).toBe(SOL_MINT);
        expect(notes[0]?.utxo.amount).toBe(DEPOSIT_AMOUNT);
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

    await testMaterialSource().withMaterial(TEST_REQUEST, async (material) => {
      const runtimeClient = (await indexer(
        script,
        transactionCursors,
        material
      )) as unknown as ZolanaClient;

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

  it("keeps a concurrent clean hydration cached when an older incomplete sync settles", async () => {
    const transactionCursors: string[] = [];
    const script: IndexerScript = { corrupt: false, indexedThrough: 1 };

    await testMaterialSource().withMaterial(TEST_REQUEST, async (material) => {
      const fingerprint = canonicalShieldedIdentity(material.shieldedAddress);
      const base = (await indexer(script, transactionCursors, material)) as unknown as ZolanaClient;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The stale sync starts from an empty cache, so it runs on a private
      // wallet object, and answers nothing until it is released below.
      const staleClient = {
        ...base,
        getShieldedTransactionsByTags: async (
          request: Parameters<typeof base.getShieldedTransactionsByTags>[0]
        ) => {
          await gate;
          return base.getShieldedTransactionsByTags(request);
        },
      } as unknown as ZolanaClient;

      const staleKeys = readKeys(material);
      try {
        const stale = hydrateWallet({
          walletId: TEST_REQUEST.walletId,
          client: staleClient,
          keys: staleKeys,
          requireComplete: true,
        }).then(
          () => "resolved" as const,
          (error: unknown) => error
        );

        // Meanwhile a clean reporting hydration completes and caches its own
        // wallet — an entry the stale sync never touched.
        const cleanKeys = readKeys(material);
        let clean: Awaited<ReturnType<typeof hydrateWallet>>;
        try {
          clean = await hydrateWallet({
            walletId: TEST_REQUEST.walletId,
            client: base,
            keys: cleanKeys,
            requireComplete: false,
          });
        } finally {
          cleanKeys.destroy();
        }
        expect(getCachedWallet(TEST_REQUEST.walletId, fingerprint)).toBe(clean.wallet);

        // Release the stale sync into incomplete data: it must refuse, and its
        // eviction must not discard the clean entry that arrived after it began.
        script.corrupt = true;
        script.indexedThrough = EVENT_POSITION;
        release();

        expect(await stale).toMatchObject({ code: "gateway_unavailable" });
        expect(getCachedWallet(TEST_REQUEST.walletId, fingerprint)).toBe(clean.wallet);
      } finally {
        staleKeys.destroy();
      }
    });
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
