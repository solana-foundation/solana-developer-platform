import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { REDACTION_CENSOR } from "@/runtime/log-redaction";
import { HeliusRingsConnectionStore } from "@/services/stores/helius-rings-connection.store";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { HeliusRingsEventRepository } from "./helius-rings-event.repository";
import {
  mapHeliusRingsEventRow,
  redactHeliusRingsEventPayload,
} from "./helius-rings-event.repository";
import { createPostgresHeliusRingsEventRepository } from "./helius-rings-event.repository.postgres";
import type { HeliusRingsOperationRepository } from "./helius-rings-operation.repository";
import { createPostgresHeliusRingsOperationRepository } from "./helius-rings-operation.repository.postgres";
import { createPostgresHeliusRingsWalletRepository } from "./helius-rings-wallet.repository.postgres";

const TEST_PROJECT_ID = "prj_hre_repo_test";
const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

describe("redactHeliusRingsEventPayload", () => {
  it("censors rings key material wherever it appears", () => {
    const redacted = redactHeliusRingsEventPayload({
      viewingKey: "vk-secret",
      nullifierKey: "nk-secret",
      ringsMetadata: { anything: "opaque" },
      amountRaw: "1000",
    });

    expect(redacted).toEqual({
      viewingKey: REDACTION_CENSOR,
      nullifierKey: REDACTION_CENSOR,
      ringsMetadata: REDACTION_CENSOR,
      amountRaw: "1000",
    });
  });

  it("censors at arbitrary depth, unlike the one-level pino registry", () => {
    const redacted = redactHeliusRingsEventPayload({
      a: { b: { c: { viewingKey: "vk-secret", label: "keep" } } },
    });

    expect(redacted).toEqual({
      a: { b: { c: { viewingKey: REDACTION_CENSOR, label: "keep" } } },
    });
  });

  it("censors through arrays", () => {
    const redacted = redactHeliusRingsEventPayload({
      keyRefs: [{ material: "sealed", kind: "viewing" }],
    });

    expect(redacted).toEqual({
      keyRefs: [{ material: REDACTION_CENSOR, kind: "viewing" }],
    });
  });

  it("censors proof internals but keeps the rest of the proof readable", () => {
    const redacted = redactHeliusRingsEventPayload({
      proof: { ref: "opaque-handle", internal: "witness", source: "simulated" },
      // `ref` outside a proof parent is an ordinary reference, not a secret.
      ref: "operation-ref",
    });

    expect(redacted).toEqual({
      proof: { ref: REDACTION_CENSOR, internal: REDACTION_CENSOR, source: "simulated" },
      ref: "operation-ref",
    });
  });

  it("breaks cycles rather than throwing", () => {
    const payload: Record<string, unknown> = { kind: "loop" };
    payload.self = payload;

    // A malformed payload must not fail the state transition trying to record
    // itself.
    expect(redactHeliusRingsEventPayload(payload)).toEqual({
      kind: "loop",
      self: "[Circular]",
    });
  });

  it("passes primitives through untouched", () => {
    expect(redactHeliusRingsEventPayload("plain")).toBe("plain");
    expect(redactHeliusRingsEventPayload(null)).toBeNull();
    expect(redactHeliusRingsEventPayload(7)).toBe(7);
  });
});

describe("HeliusRingsEventRepository (postgres)", () => {
  let repo: HeliusRingsEventRepository;
  let operationRepo: HeliusRingsOperationRepository;
  let operationId: string;

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

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

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();

    const wallet = await createPostgresHeliusRingsWalletRepository(db).createWallet({
      ...scope,
      sdpWalletId: "wal_hre_repo_test",
      name: "Treasury",
      materialTag: "simulated",
    });
    if (!wallet) throw new Error("wallet fixture was not created");

    const credentialId = "pcred_hre_repo_test";
    const credential = await new ProviderCredentialStore(db).insertCredential({
      id: credentialId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      provider: "helius_rings",
      label: "Event repository test",
      scope: "project",
      source: "stored",
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "opaque" },
      displayMetadata: {},
      version: 1,
      rotatedFromId: null,
      idempotencyKey: credentialId,
      idempotencyFingerprint: credentialId,
      createdBy: TEST_USER.id,
    });
    await db.execute("UPDATE provider_credentials SET status = 'active' WHERE id = ?", [
      credentialId,
    ]);
    const connection = await new HeliusRingsConnectionStore(db).insert({
      id: "hrconn_hre_repo_test",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      name: "Event repository test",
      providerCredentialId: credentialId,
      providerCredentialScopeKey: credential.scope_key,
      allowInsecureHttp: false,
      displayMetadata: {},
      makeDefault: true,
      createdBy: TEST_USER.id,
    });

    operationRepo = createPostgresHeliusRingsOperationRepository(db);
    const { operation } = await operationRepo.reserveIntent({
      ...scope,
      ringsConnectionId: connection.id,
      walletId: wallet.id,
      opType: "shield",
      intentKey: "sha256:event-test",
    });
    operationId = operation.id;

    repo = createPostgresHeliusRingsEventRepository(db);
  });

  it("appends an event with its payload", async () => {
    const event = await repo.append({
      operationId,
      kind: "state.transitioned",
      payload: { from: "draft", to: "preparing" },
    });

    expect(event).toMatchObject({
      operation_id: operationId,
      kind: "state.transitioned",
      payload: { from: "draft", to: "preparing" },
    });
  });

  it("redacts key material before it reaches the table", async () => {
    await repo.append({
      operationId,
      kind: "wallet.provisioned",
      payload: { viewingKey: "vk-secret", shieldedAddress: "shielded-1" },
    });

    const [stored] = await repo.listByOperation({ operationId });
    expect(stored.payload).toEqual({
      viewingKey: REDACTION_CENSOR,
      shieldedAddress: "shielded-1",
    });

    // Belt and braces: the literal secret is nowhere in the column.
    const raw = await getDb(env)
      .prepare("SELECT payload::text AS payload FROM helius_rings_events WHERE operation_id = ?")
      .bind(operationId)
      .first<{ payload: string }>();
    expect(raw?.payload).not.toContain("vk-secret");
  });

  it("accepts an event with no payload", async () => {
    const event = await repo.append({ operationId, kind: "operation.created" });

    expect(event.payload).toBeNull();
  });

  it("lists the timeline oldest first", async () => {
    await repo.append({ operationId, kind: "first" });
    await repo.append({ operationId, kind: "second" });
    await repo.append({ operationId, kind: "third" });
    const db = getDb(env);
    await db
      .prepare("UPDATE helius_rings_events SET created_at = ? WHERE kind = ?")
      .bind("2026-01-01T00:00:00.000Z", "first")
      .run();
    await db
      .prepare("UPDATE helius_rings_events SET created_at = ? WHERE kind = ?")
      .bind("2026-02-01T00:00:00.000Z", "second")
      .run();
    await db
      .prepare("UPDATE helius_rings_events SET created_at = ? WHERE kind = ?")
      .bind("2026-03-01T00:00:00.000Z", "third")
      .run();

    const events = await repo.listByOperation({ operationId });
    expect(events.map((event) => event.kind)).toEqual(["first", "second", "third"]);
  });

  it("honours the list limit", async () => {
    await repo.append({ operationId, kind: "first" });
    await repo.append({ operationId, kind: "second" });

    expect(await repo.listByOperation({ operationId, limit: 1 })).toHaveLength(1);
  });

  it("maps a row onto the domain event", async () => {
    const event = await repo.append({ operationId, kind: "state.transitioned", payload: null });

    expect(mapHeliusRingsEventRow(event)).toEqual({
      kind: "state.transitioned",
      createdAt: event.created_at,
      payload: undefined,
    });
  });
});
