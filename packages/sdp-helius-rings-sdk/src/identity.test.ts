import type { ReadIdentityResult } from "@sdp/helius-rings";
import { getBase58Decoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  derivedIdentity,
  honestRecord,
  publishedKeys,
  TEST_OWNER,
  TEST_REQUEST,
  TEST_SEED,
} from "./test/support.js";

const fetchUserRecord = vi.fn();

/**
 * Only the account read is doubled. `resolvedAddressFromRecord` stays real
 * because it is the claim under test: that what leaves is the compressed
 * commitment the SDK itself computes over a record, not the record's fields.
 * Stubbing it would leave the test asserting its own fake.
 */
vi.mock("@heliuslabs/zolana/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana/wallet")>()),
  fetchUserRecord: (...args: unknown[]) => fetchUserRecord(...args),
}));

const { createDeterministicMaterialSource } = await import("./deterministic-ka/index.js");
const { readRingsIdentityStatus } = await import("./identity.js");

const OWNER = TEST_OWNER;
/** A second real Solana address, for the record that names the wrong owner. */
const OTHER_OWNER = "Gw2CGVLvVSFcNQKKYtCk6VqQtNvHiUCBRLPuVQGnkVBk";

const INPUT = { walletId: TEST_REQUEST.walletId, owner: OWNER };

/**
 * Someone else's identity published under this owner.
 *
 * The foreign halves are real keys from another wallet's derivation rather than
 * filler bytes. A viewing public key is a P-256 point and a nullifier public
 * key a field element, so canonicalising a record built from arbitrary bytes
 * would fail at the decode and never reach the comparison this asserts on.
 */
const FOREIGN = { ...TEST_REQUEST, walletId: "hrw_someone_else" };

function deps() {
  return {
    client: {} as never,
    material: createDeterministicMaterialSource({ seed: TEST_SEED }),
    organizationId: TEST_REQUEST.organizationId,
    projectId: TEST_REQUEST.projectId,
  };
}

describe("readRingsIdentityStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports an owner with no record as unregistered", async () => {
    fetchUserRecord.mockResolvedValue(undefined);

    const result = await readRingsIdentityStatus(deps(), INPUT);

    expect(result).toEqual({
      status: "unregistered",
      derivedShieldedAddress: await derivedIdentity(),
      // Null is the whole difference from a foreign record: nothing is
      // published, so provisioning will create the identity rather than refuse.
      publishedShieldedAddress: null,
      mismatch: null,
    });
  });

  it("reports a record this tenant genuinely derives as ours", async () => {
    fetchUserRecord.mockResolvedValue(await honestRecord());

    const result = await readRingsIdentityStatus(deps(), INPUT);
    const derived = await derivedIdentity();

    expect(result).toEqual({
      status: "ours",
      derivedShieldedAddress: derived,
      publishedShieldedAddress: derived,
      mismatch: null,
    });
  });

  // The published address is canonicalised from the record rather than copied
  // from the derivation, so "ours" has to be an agreement of two independently
  // computed values, not one value reported twice.
  it("canonicalises the published address from the record it read", async () => {
    const foreign = await publishedKeys(FOREIGN);
    fetchUserRecord.mockResolvedValue({
      ...(await honestRecord()),
      nullifierPublicKey: foreign.nullifierPublicKey,
      viewingPublicKey: foreign.viewingPublicKey,
    });

    const result = await readRingsIdentityStatus(deps(), INPUT);

    expect(result.publishedShieldedAddress).toBe(await derivedIdentity(FOREIGN));
    expect(result.publishedShieldedAddress).not.toBe(result.derivedShieldedAddress);
  });

  it("reports a record publishing a foreign nullifier key as foreign", async () => {
    fetchUserRecord.mockResolvedValue({
      ...(await honestRecord()),
      nullifierPublicKey: (await publishedKeys(FOREIGN)).nullifierPublicKey,
    });

    const result = await readRingsIdentityStatus(deps(), INPUT);

    // Foreign, not a rotation to take: SDP does not re-key a published
    // identity, so the resolution is a different custody wallet.
    expect(result).toMatchObject({ status: "foreign", mismatch: "nullifier_key" });
    expect(result.derivedShieldedAddress).toBe(await derivedIdentity());
  });

  it("reports a record publishing a foreign viewing key as foreign", async () => {
    fetchUserRecord.mockResolvedValue({
      ...(await honestRecord()),
      viewingPublicKey: (await publishedKeys(FOREIGN)).viewingPublicKey,
    });

    await expect(readRingsIdentityStatus(deps(), INPUT)).resolves.toMatchObject({
      status: "foreign",
      mismatch: "viewing_key",
    });
  });

  it("reports a record naming a different owner as foreign", async () => {
    fetchUserRecord.mockResolvedValue({ ...(await honestRecord()), owner: OTHER_OWNER });

    await expect(readRingsIdentityStatus(deps(), INPUT)).resolves.toMatchObject({
      status: "foreign",
      mismatch: "owner",
    });
  });

  // The owner is checked before either key, so a record that is wrong in more
  // than one way names the outermost difference rather than an inner one.
  it("names the owner ahead of the keys when both differ", async () => {
    const foreign = await publishedKeys(FOREIGN);
    fetchUserRecord.mockResolvedValue({
      ...(await honestRecord()),
      owner: OTHER_OWNER,
      nullifierPublicKey: foreign.nullifierPublicKey,
      viewingPublicKey: foreign.viewingPublicKey,
    });

    await expect(readRingsIdentityStatus(deps(), INPUT)).resolves.toMatchObject({
      mismatch: "owner",
    });
  });

  it("reads the record for the owner it was given, and nothing else", async () => {
    fetchUserRecord.mockResolvedValue(undefined);

    await readRingsIdentityStatus(deps(), INPUT);

    expect(fetchUserRecord).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ owner: OWNER })
    );
  });

  describe("response shape", () => {
    /**
     * Every byte-array-shaped value reachable in the result, at any depth. A
     * viewing public key is 33 bytes and a nullifier public key 32, so an
     * array of either length is the signature of a leak whatever it is named.
     */
    function keyLengthArraysIn(value: unknown): unknown[] {
      if (value instanceof Uint8Array || Array.isArray(value)) {
        return value.length === 32 || value.length === 33 ? [value] : [];
      }
      if (value === null || typeof value !== "object") return [];
      return Object.values(value).flatMap(keyLengthArraysIn);
    }

    /** Every encoding a string field could plausibly be carrying bytes under. */
    function encodingsOf(bytes: Uint8Array): string[] {
      return [
        getBase58Decoder().decode(bytes),
        Buffer.from(bytes).toString("base64"),
        Buffer.from(bytes).toString("hex"),
      ];
    }

    async function readWith(record: unknown): Promise<ReadIdentityResult> {
      fetchUserRecord.mockResolvedValue(record);
      return readRingsIdentityStatus(deps(), INPUT);
    }

    it("carries exactly the four documented fields and nothing else", async () => {
      const result = await readWith(await honestRecord({ mergingEnabled: true }));

      // `bump`, `mergingEnabled`, and the raw account data all live one spread
      // away, so the field set is asserted whole rather than by naming what
      // must be absent.
      expect(Object.keys(result).sort()).toEqual([
        "derivedShieldedAddress",
        "mismatch",
        "publishedShieldedAddress",
        "status",
      ]);
    });

    it.each([
      ["ours", async () => honestRecord({ mergingEnabled: true })],
      [
        "foreign",
        async () => {
          const theirs = await publishedKeys(FOREIGN);
          return {
            ...(await honestRecord({ mergingEnabled: true })),
            nullifierPublicKey: theirs.nullifierPublicKey,
            viewingPublicKey: theirs.viewingPublicKey,
          };
        },
      ],
      ["unregistered", async () => undefined],
    ])("leaks no key bytes on the %s path", async (_status, buildRecord) => {
      const result = await readWith(await buildRecord());
      const serialised = JSON.stringify(result);

      expect(keyLengthArraysIn(result)).toEqual([]);

      // Both the keys this tenant derives and the ones a foreign record
      // publishes: neither may appear, under any encoding, in either direction.
      const ours = await publishedKeys();
      const theirs = await publishedKeys(FOREIGN);
      for (const bytes of [
        ours.nullifierPublicKey,
        ours.viewingPublicKey,
        theirs.nullifierPublicKey,
        theirs.viewingPublicKey,
        TEST_SEED,
      ]) {
        for (const encoded of encodingsOf(bytes)) {
          expect(serialised).not.toContain(encoded);
        }
      }
    });
  });
});
