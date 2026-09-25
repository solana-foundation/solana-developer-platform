import type { Signature } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { PrivateChannelReleaseScanRepository } from "./private-channel-release-scan.repository";
import { createPostgresPrivateChannelReleaseScanRepository } from "./private-channel-release-scan.repository";

const TEST_PROJECT_ID = "prj_pcrs_repo_test";
const INSTANCE = "inst_pcrs_1";
const MINT = "MintAddr1111111111111111111111111111111111";
const VAULT = "VaultAta11111111111111111111111111111111111";

// Runtime signatures are plain TEXT columns; the brand exists for call sites.
const cursor = (sig: string, slot: string) => ({ signature: sig as Signature, slot });

describe("PrivateChannelReleaseScanRepository (postgres)", () => {
  let repo: PrivateChannelReleaseScanRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM private_channel_release_scans").run();
    await db.prepare("DELETE FROM private_channel_instances").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: "prj_pcrs_repo_production" },
    });
    await db
      .prepare(
        `INSERT INTO private_channel_instances (
           id, organization_id, project_id, gateway_url,
           escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active
         ) VALUES (?, ?, ?, 'https://gateway.example',
           'escrow_program', 'withdraw_program', 'escrow_instance', 'https://auth.example', TRUE)`
      )
      .bind(INSTANCE, TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    repo = createPostgresPrivateChannelReleaseScanRepository(db);
  });

  it("reads null before the first write", async () => {
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toBeNull();
  });

  it("round-trips an advance and never moves the frontier back to an older slot", async () => {
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sigShallow", "100"),
      expectedCursorSignature: null,
    });
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toEqual({
      cursor: { signature: "sigShallow", slot: "100" },
      sweep: null,
    });

    // A deeper (older-slot) position — e.g. from a slower overlapping sweep
    // that parsed less — must not undo the frontier's progress.
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sigDeep", "50"),
      expectedCursorSignature: "sigShallow" as Signature,
    });
    expect((await repo.getScan(INSTANCE, MINT, VAULT))?.cursor).toEqual({
      signature: "sigShallow",
      slot: "100",
    });

    // Newer positions keep advancing.
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sigNewer", "200"),
      expectedCursorSignature: "sigShallow" as Signature,
    });
    expect((await repo.getScan(INSTANCE, MINT, VAULT))?.cursor).toEqual({
      signature: "sigNewer",
      slot: "200",
    });
  });

  it("advances the frontier within a slot when anchored at the stored cursor", async () => {
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sig300", "900"),
      expectedCursorSignature: null,
    });

    // Slots are not unique: the frontier can legitimately land back inside
    // the cursor's own slot (more successful same-slot entries than the
    // per-tick parse budget). That advance must not be dropped, or the
    // cursor freezes and releases above it in the slot are never consumed.
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sig400", "900"),
      expectedCursorSignature: "sig300" as Signature,
    });
    expect((await repo.getScan(INSTANCE, MINT, VAULT))?.cursor).toEqual({
      signature: "sig400",
      slot: "900",
    });
  });

  it("rejects a same-slot advance not anchored at the stored cursor", async () => {
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sig300", "900"),
      expectedCursorSignature: null,
    });

    // A lagging poller that read an earlier position proposes a same-slot
    // frontier it listed BEFORE the stored cursor: the compare-and-set fails
    // and the frontier does not regress within the slot.
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sig100", "900"),
      expectedCursorSignature: "sigStaleRead" as Signature,
    });
    expect((await repo.getScan(INSTANCE, MINT, VAULT))?.cursor).toEqual({
      signature: "sig300",
      slot: "900",
    });
  });

  it("sets the cursor on a row that only carried a sweep", async () => {
    await repo.deepenSweep({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      sweep: cursor("sweepSig", "10"),
    });
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toEqual({
      cursor: null,
      sweep: { signature: "sweepSig", slot: "10" },
    });

    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("frontierSig", "20"),
      expectedCursorSignature: null,
    });
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toEqual({
      cursor: { signature: "frontierSig", slot: "20" },
      sweep: { signature: "sweepSig", slot: "10" },
    });
  });

  it("only deepens the sweep and clears it in place", async () => {
    await repo.deepenSweep({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      sweep: cursor("sweepDeep", "100"),
    });
    // A shallower (newer-slot) proposal must not regress the sweep.
    await repo.deepenSweep({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      sweep: cursor("sweepShallow", "200"),
    });
    expect((await repo.getScan(INSTANCE, MINT, VAULT))?.sweep).toEqual({
      signature: "sweepDeep",
      slot: "100",
    });

    // Deeper positions keep advancing.
    await repo.deepenSweep({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      sweep: cursor("sweepDeeper", "50"),
    });
    expect((await repo.getScan(INSTANCE, MINT, VAULT))?.sweep).toEqual({
      signature: "sweepDeeper",
      slot: "50",
    });

    await repo.clearSweep({ instanceId: INSTANCE, mint: MINT, vaultAta: VAULT });
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toEqual({
      cursor: null,
      sweep: null,
    });
  });

  it("keeps per-escrow positions so a lagging poller cannot clobber a rotated escrow's cursor", async () => {
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("oldEscrowSig", "100"),
      expectedCursorSignature: null,
    });

    const rotated = "VaultAta22222222222222222222222222222222222";
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: rotated,
      cursor: cursor("newEscrowSig", "9000"),
      expectedCursorSignature: null,
    });

    // The rotated escrow reads as unwalked until its first advance — history
    // on the new ATA has not been walked yet — and the old escrow's position
    // never leaks across addresses.
    expect(await repo.getScan(INSTANCE, MINT, rotated)).toEqual({
      cursor: { signature: "newEscrowSig", slot: "9000" },
      sweep: null,
    });
    expect((await repo.getScan(INSTANCE, MINT, VAULT))?.cursor).toEqual({
      signature: "oldEscrowSig",
      slot: "100",
    });

    // A lagging poller still holding the OLD escrow address advances late and
    // must not clobber the rotated escrow's progress (or vice versa).
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("oldEscrowSig2", "150"),
      expectedCursorSignature: "oldEscrowSig" as Signature,
    });
    expect((await repo.getScan(INSTANCE, MINT, rotated))?.cursor).toEqual({
      signature: "newEscrowSig",
      slot: "9000",
    });
  });

  it("scopes positions per (instance, mint) pair", async () => {
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sigA", "10"),
      expectedCursorSignature: null,
    });
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: "MintOther2222222222222222222222222222222222",
      vaultAta: VAULT,
      cursor: cursor("sigB", "20"),
      expectedCursorSignature: null,
    });
    const firstScan = await repo.getScan(INSTANCE, MINT, VAULT);
    expect(firstScan?.cursor?.signature).toBe("sigA");
    const secondScan = await repo.getScan(
      INSTANCE,
      "MintOther2222222222222222222222222222222222",
      VAULT
    );
    expect(secondScan?.cursor?.signature).toBe("sigB");
  });
});
