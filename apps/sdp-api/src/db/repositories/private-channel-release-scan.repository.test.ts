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

  it("reads null before the first advance", async () => {
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toBeNull();
  });

  it("round-trips an advance and refuses to move the cursor back to a newer slot", async () => {
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sigDeep", "100"),
    });
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toEqual({
      signature: "sigDeep",
      slot: "100",
    });

    // A shallower (newer-slot) position — e.g. from a slower overlapping sweep
    // that parsed less — must not undo the deeper one.
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sigShallow", "200"),
    });
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toEqual({
      signature: "sigDeep",
      slot: "100",
    });

    // Deeper positions keep advancing.
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sigDeeper", "50"),
    });
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toEqual({
      signature: "sigDeeper",
      slot: "50",
    });
  });

  it("discards the cursor wholesale when the escrow ATA rotated", async () => {
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("oldEscrowSig", "100"),
    });

    const rotated = "VaultAta22222222222222222222222222222222222";
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: rotated,
      cursor: cursor("newEscrowSig", "9000"),
    });

    // The rotated escrow's first position wins despite its newer slot, and the
    // old escrow's position is gone rather than leaking across addresses.
    expect(await repo.getScan(INSTANCE, MINT, rotated)).toEqual({
      signature: "newEscrowSig",
      slot: "9000",
    });
    expect(await repo.getScan(INSTANCE, MINT, VAULT)).toBeNull();
  });

  it("scopes cursors per (instance, mint) pair", async () => {
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: MINT,
      vaultAta: VAULT,
      cursor: cursor("sigA", "10"),
    });
    await repo.advanceScan({
      instanceId: INSTANCE,
      mint: "MintOther2222222222222222222222222222222222",
      vaultAta: VAULT,
      cursor: cursor("sigB", "20"),
    });
    const firstScan = await repo.getScan(INSTANCE, MINT, VAULT);
    expect(firstScan?.signature).toBe("sigA");
    const secondScan = await repo.getScan(
      INSTANCE,
      "MintOther2222222222222222222222222222222222",
      VAULT
    );
    expect(secondScan?.signature).toBe("sigB");
  });
});
