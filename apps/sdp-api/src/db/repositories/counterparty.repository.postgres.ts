import type {
  CounterpartyIndividualIdentity,
  CounterpartyProviderData,
  CounterpartyStatus,
} from "@sdp/types";
import type { AppDb, DatabaseExecutor } from "@/db";
import type { PiiCipher, PiiCipherContext } from "@/services/pii-cipher/pii-cipher";
import type {
  ArchiveCounterpartyInput,
  CounterpartiesRepository,
  CounterpartyRow,
  CreateCounterpartyInput,
  ListCounterpartiesInput,
  ListCounterpartiesResult,
  MutateCounterpartyProviderDataInput,
  UpdateCounterpartyInput,
  UpsertBvnkCustomerProviderDataInput,
} from "./counterparty.repository";
import { generateCounterpartyId } from "./counterparty.repository";
import {
  acquireCounterpartyPiiWriteLock,
  getCounterpartyPiiMigrationPhase,
  providerLookupReferences,
  recordCounterpartyPiiFallbackRead,
} from "./counterparty-pii.repository";

interface CounterpartyPiiPayload {
  email: string;
  identity?: CounterpartyIndividualIdentity;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Counterparty ${field} is missing`);
  }
  return value;
}

/**
 * Requires the individual identity carried by a counterparty PII payload.
 *
 * @param identity Individual identity from encrypted or dual-write storage.
 * @returns The required individual identity.
 */
function requireIndividualIdentity(
  identity: CounterpartyIndividualIdentity | undefined
): CounterpartyIndividualIdentity {
  if (identity === undefined) {
    throw new Error("Individual counterparty identity is missing");
  }
  return identity;
}

/**
 * Projects a permissively parsed identity onto the supported public contract.
 *
 * @param identity Identity that may contain legacy extra keys.
 * @returns The supported individual identity fields.
 */
function supportedIndividualIdentity(
  identity: CounterpartyIndividualIdentity
): CounterpartyIndividualIdentity {
  const supported: CounterpartyIndividualIdentity = {
    firstName: identity.firstName,
    lastName: identity.lastName,
    dateOfBirth: identity.dateOfBirth,
  };
  if (identity.middleName !== undefined) {
    supported.middleName = identity.middleName;
  }
  if (identity.secondLastName !== undefined) {
    supported.secondLastName = identity.secondLastName;
  }
  return supported;
}

function parseObject<T extends object>(value: string, field: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Counterparty ${field} ciphertext contains invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Counterparty ${field} ciphertext must contain a JSON object`);
  }
  return parsed as T;
}

function contextFor(
  row: Record<string, unknown>,
  field: "identity" | "provider_data"
): PiiCipherContext {
  return {
    organizationId: assertString(row.organization_id, "organization_id"),
    projectId: assertString(row.project_id, "project_id"),
    resourceType: "counterparty",
    resourceId: assertString(row.id, "id"),
    field,
  };
}

async function mapCounterpartyRow(
  db: DatabaseExecutor,
  cipher: PiiCipher,
  row: Record<string, unknown>
): Promise<CounterpartyRow> {
  let usedFallback = false;
  let pii: CounterpartyPiiPayload;
  const piiEncrypted = row.pii_encrypted;
  if (typeof piiEncrypted === "string") {
    pii = parseObject<CounterpartyPiiPayload>(
      await cipher.decrypt(contextFor(row, "identity"), piiEncrypted),
      "identity"
    );
  } else {
    usedFallback = true;
    pii = {
      email: assertString(row.email, "email"),
      identity:
        row.entity_type === "individual"
          ? (row.identity as CounterpartyIndividualIdentity)
          : undefined,
    };
  }

  let providerData: CounterpartyProviderData;
  const providerDataEncrypted = row.provider_data_encrypted;
  if (typeof providerDataEncrypted === "string") {
    providerData = parseObject<CounterpartyProviderData>(
      await cipher.decrypt(contextFor(row, "provider_data"), providerDataEncrypted),
      "provider_data"
    );
  } else {
    usedFallback = true;
    providerData = (row.provider_data as CounterpartyProviderData | null) ?? {};
  }

  if (usedFallback) {
    await recordCounterpartyPiiFallbackRead(db);
  }

  const base = {
    id: assertString(row.id, "id"),
    organization_id: assertString(row.organization_id, "organization_id"),
    project_id: assertString(row.project_id, "project_id"),
    external_id: (row.external_id as string | null) ?? null,
    display_name: assertString(row.display_name, "display_name"),
    email: pii.email,
    provider_data: providerData,
    status: row.status as CounterpartyStatus,
    created_by: (row.created_by as string | null) ?? null,
    created_at: assertString(row.created_at, "created_at"),
    updated_at: assertString(row.updated_at, "updated_at"),
  };
  return row.entity_type === "individual"
    ? {
        ...base,
        entity_type: "individual",
        identity: supportedIndividualIdentity(requireIndividualIdentity(pii.identity)),
      }
    : {
        ...base,
        entity_type: "business",
      };
}

function piiContext(input: {
  organizationId: string;
  projectId: string;
  counterpartyId: string;
  field: "identity" | "provider_data";
}): PiiCipherContext {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    resourceType: "counterparty",
    resourceId: input.counterpartyId,
    field: input.field,
  };
}

async function encryptCounterpartyData(
  cipher: PiiCipher,
  input: {
    counterpartyId: string;
    organizationId: string;
    projectId: string;
    email: string;
    identity: CounterpartyIndividualIdentity | undefined;
    providerData: CounterpartyProviderData;
  }
): Promise<{ piiEncrypted: string; providerDataEncrypted: string }> {
  const piiPayload: CounterpartyPiiPayload = { email: input.email };
  if (input.identity !== undefined) {
    piiPayload.identity = input.identity;
  }
  const [piiEncrypted, providerDataEncrypted] = await Promise.all([
    cipher.encrypt(piiContext({ ...input, field: "identity" }), JSON.stringify(piiPayload)),
    cipher.encrypt(
      piiContext({ ...input, field: "provider_data" }),
      JSON.stringify(input.providerData)
    ),
  ]);
  return { piiEncrypted, providerDataEncrypted };
}

async function getCounterpartyByIdInternal(
  db: DatabaseExecutor,
  cipher: PiiCipher,
  params: { counterpartyId: string; organizationId: string; projectId: string }
): Promise<CounterpartyRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM counterparties
         WHERE id = ?
           AND organization_id = ?
           AND project_id = ?`
    )
    .bind(params.counterpartyId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();
  return row ? mapCounterpartyRow(db, cipher, row) : null;
}

async function updateProviderData(
  db: DatabaseExecutor,
  cipher: PiiCipher,
  current: CounterpartyRow,
  providerData: CounterpartyProviderData,
  phase: "dual_write" | "encrypted_only"
): Promise<void> {
  const providerDataEncrypted = await cipher.encrypt(
    piiContext({
      organizationId: current.organization_id,
      projectId: current.project_id,
      counterpartyId: current.id,
      field: "provider_data",
    }),
    JSON.stringify(providerData)
  );
  const refs = providerLookupReferences(providerData);
  await db
    .prepare(
      `UPDATE counterparties
          SET provider_data = ?,
              provider_data_encrypted = ?,
              bvnk_customer_reference = ?,
              mural_organization_id = ?,
              updated_at = sdp_iso_now()
        WHERE id = ?`
    )
    .bind(
      phase === "dual_write" ? providerData : null,
      providerDataEncrypted,
      refs.bvnkCustomerReference,
      refs.muralOrganizationId,
      current.id
    )
    .run();
}

async function mutateProviderDataLocked(
  db: AppDb,
  cipher: PiiCipher,
  params: MutateCounterpartyProviderDataInput
): Promise<CounterpartyRow | null> {
  return db.transaction(async (tx) => {
    await acquireCounterpartyPiiWriteLock(tx);
    const phase = await getCounterpartyPiiMigrationPhase(tx);
    const row = await tx
      .prepare(
        `SELECT * FROM counterparties
          WHERE id = ?
            AND organization_id = ?
            AND project_id = ?
            AND status = 'active'
          FOR UPDATE`
      )
      .bind(params.counterpartyId, params.organizationId, params.projectId)
      .first<Record<string, unknown>>();
    if (!row) {
      return null;
    }
    const current = await mapCounterpartyRow(tx, cipher, row);
    await updateProviderData(tx, cipher, current, params.mutate(current.provider_data), phase);
    return getCounterpartyByIdInternal(tx, cipher, params);
  });
}

/**
 * Resolves the identity stored after a counterparty update.
 *
 * @param input Validated repository update input.
 * @param current Current persisted counterparty.
 * @param entityType Entity type after the update.
 * @returns The individual identity, or undefined for a business.
 */
function updatedIdentity(
  input: UpdateCounterpartyInput,
  current: CounterpartyRow,
  entityType: "individual" | "business"
): CounterpartyIndividualIdentity | undefined {
  if (entityType === "business") {
    return undefined;
  }
  if (input.identity !== undefined) {
    return input.identity;
  }
  if (current.entity_type === "individual") {
    return current.identity;
  }
  throw new Error("Individual counterparty identity is required");
}

export function createPostgresCounterpartiesRepository(
  db: AppDb,
  cipher: PiiCipher
): CounterpartiesRepository {
  return {
    async createCounterparty(input: CreateCounterpartyInput) {
      const id = generateCounterpartyId();
      const providerData = input.providerData;
      const identity = input.entityType === "individual" ? input.identity : undefined;
      const encrypted = await encryptCounterpartyData(cipher, {
        counterpartyId: id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        email: input.email,
        identity,
        providerData,
      });
      const refs = providerLookupReferences(providerData);

      await db.transaction(async (tx) => {
        await acquireCounterpartyPiiWriteLock(tx);
        const phase = await getCounterpartyPiiMigrationPhase(tx);
        await tx
          .prepare(
            `INSERT INTO counterparties (
               id, organization_id, project_id, external_id, entity_type,
               display_name, email, identity, provider_data, pii_encrypted,
               provider_data_encrypted, bvnk_customer_reference,
               mural_organization_id, status, created_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
          )
          .bind(
            id,
            input.organizationId,
            input.projectId,
            input.externalId,
            input.entityType,
            input.displayName,
            phase === "dual_write" ? input.email : null,
            phase === "dual_write" && identity !== undefined ? identity : null,
            phase === "dual_write" ? providerData : null,
            encrypted.piiEncrypted,
            encrypted.providerDataEncrypted,
            refs.bvnkCustomerReference,
            refs.muralOrganizationId,
            input.createdBy
          )
          .run();
      });

      return getCounterpartyByIdInternal(db, cipher, {
        counterpartyId: id,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });
    },

    async updateCounterparty(input: UpdateCounterpartyInput) {
      return db.transaction(async (tx) => {
        await acquireCounterpartyPiiWriteLock(tx);
        const phase = await getCounterpartyPiiMigrationPhase(tx);
        const row = await tx
          .prepare(
            `SELECT * FROM counterparties
              WHERE id = ?
                AND organization_id = ?
                AND project_id = ?
                AND status = 'active'
              FOR UPDATE`
          )
          .bind(input.counterpartyId, input.organizationId, input.projectId)
          .first<Record<string, unknown>>();
        if (!row) {
          return null;
        }
        const current = await mapCounterpartyRow(tx, cipher, row);
        const email = input.email === undefined ? current.email : input.email;
        const entityType = input.entityType === undefined ? current.entity_type : input.entityType;
        const identity = updatedIdentity(input, current, entityType);
        const providerData =
          input.providerData === undefined ? current.provider_data : input.providerData;
        const encrypted = await encryptCounterpartyData(cipher, {
          counterpartyId: current.id,
          organizationId: current.organization_id,
          projectId: current.project_id,
          email,
          identity,
          providerData,
        });
        const refs = providerLookupReferences(providerData);

        await tx
          .prepare(
            `UPDATE counterparties
                SET external_id = CASE WHEN ?::boolean THEN ? ELSE external_id END,
                    entity_type = ?,
                    display_name = ?,
                    email = ?,
                    identity = ?,
                    provider_data = ?,
                    pii_encrypted = ?,
                    provider_data_encrypted = ?,
                    bvnk_customer_reference = ?,
                    mural_organization_id = ?,
                    updated_at = sdp_iso_now()
              WHERE id = ?`
          )
          .bind(
            input.externalId !== undefined,
            input.externalId === undefined ? null : input.externalId,
            entityType,
            input.displayName === undefined ? current.display_name : input.displayName,
            phase === "dual_write" ? email : null,
            phase === "dual_write" ? identity : null,
            phase === "dual_write" ? providerData : null,
            encrypted.piiEncrypted,
            encrypted.providerDataEncrypted,
            refs.bvnkCustomerReference,
            refs.muralOrganizationId,
            current.id
          )
          .run();

        return getCounterpartyByIdInternal(tx, cipher, {
          counterpartyId: current.id,
          organizationId: current.organization_id,
          projectId: current.project_id,
        });
      });
    },

    async archiveCounterparty(input: ArchiveCounterpartyInput) {
      const row = await db
        .prepare(
          `UPDATE counterparties
              SET status = 'archived',
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = 'active'
          RETURNING *`
        )
        .bind(input.counterpartyId, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(db, cipher, row) : null;
    },

    async getCounterpartyById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = 'active'`
        )
        .bind(params.counterpartyId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(db, cipher, row) : null;
    },

    async getCounterpartyByExternalId(params) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE organization_id = ?
              AND project_id = ?
              AND external_id = ?
              AND status = 'active'`
        )
        .bind(params.organizationId, params.projectId, params.externalId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(db, cipher, row) : null;
    },

    async findActiveCounterpartyById(counterpartyId: string) {
      const row = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE id = ?
              AND status = 'active'
            LIMIT 1`
        )
        .bind(counterpartyId)
        .first<Record<string, unknown>>();
      return row ? mapCounterpartyRow(db, cipher, row) : null;
    },

    async findActiveCounterpartyByBvnkCustomerReference(customerReference: string) {
      const rows = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE status = 'active'
              AND (
                bvnk_customer_reference = ?
                OR (
                  bvnk_customer_reference IS NULL
                  AND provider_data->'bvnk'->'customer'->>'customerReference' = ?
                )
              )
            ORDER BY id
            LIMIT 2`
        )
        .bind(customerReference, customerReference)
        .all<Record<string, unknown>>();
      return rows.results.length === 1
        ? mapCounterpartyRow(db, cipher, rows.results[0] as Record<string, unknown>)
        : null;
    },

    async findCounterpartyByMuralOrganizationId(organizationId: string) {
      const rows = await db
        .prepare(
          `SELECT * FROM counterparties
            WHERE status = 'active'
              AND (
                mural_organization_id = ?
                OR (
                  mural_organization_id IS NULL
                  AND provider_data->'mural'->'organization'->>'id' = ?
                )
              )
            ORDER BY id
            LIMIT 2`
        )
        .bind(organizationId, organizationId)
        .all<Record<string, unknown>>();
      return rows.results.length === 1
        ? mapCounterpartyRow(db, cipher, rows.results[0] as Record<string, unknown>)
        : null;
    },

    async mutateProviderData(params) {
      return mutateProviderDataLocked(db, cipher, params);
    },

    async upsertBvnkCustomerProviderData(params: UpsertBvnkCustomerProviderDataInput) {
      await mutateProviderDataLocked(db, cipher, {
        ...params,
        mutate(currentProviderData) {
          const bvnk =
            currentProviderData.bvnk && typeof currentProviderData.bvnk === "object"
              ? (currentProviderData.bvnk as Record<string, unknown>)
              : {};
          const customer =
            bvnk.customer && typeof bvnk.customer === "object"
              ? (bvnk.customer as Record<string, unknown>)
              : {};
          return {
            ...currentProviderData,
            bvnk: {
              ...bvnk,
              customer: { ...customer, ...params.customer },
            },
          };
        },
      });
    },

    async patchMuralOrganizationById(params) {
      await db.transaction(async (tx) => {
        await acquireCounterpartyPiiWriteLock(tx);
        const phase = await getCounterpartyPiiMigrationPhase(tx);
        const row = await tx
          .prepare(
            `SELECT * FROM counterparties
              WHERE status = 'active'
                AND (
                  mural_organization_id = ?
                  OR (
                    mural_organization_id IS NULL
                    AND provider_data->'mural'->'organization'->>'id' = ?
                  )
                )
              LIMIT 1
              FOR UPDATE`
          )
          .bind(params.organizationId, params.organizationId)
          .first<Record<string, unknown>>();
        if (!row) {
          return;
        }
        const current = await mapCounterpartyRow(tx, cipher, row);
        const mural =
          current.provider_data.mural && typeof current.provider_data.mural === "object"
            ? (current.provider_data.mural as Record<string, unknown>)
            : {};
        const organization =
          mural.organization && typeof mural.organization === "object"
            ? (mural.organization as Record<string, unknown>)
            : {};
        await updateProviderData(
          tx,
          cipher,
          current,
          {
            ...current.provider_data,
            mural: {
              ...mural,
              organization: { ...organization, ...params.organization },
            },
          },
          phase
        );
      });
    },

    async listCounterparties(params: ListCounterpartiesInput): Promise<ListCounterpartiesResult> {
      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM counterparties
              WHERE organization_id = ?
                AND project_id = ?
                AND (?::boolean OR status = 'active')
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(
            params.organizationId,
            params.projectId,
            params.includeArchived ?? false,
            params.limit,
            params.offset
          )
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM counterparties
              WHERE organization_id = ?
                AND project_id = ?
                AND (?::boolean OR status = 'active')`
          )
          .bind(params.organizationId, params.projectId, params.includeArchived ?? false)
          .first<{ total: number }>(),
      ]);

      return {
        rows: await Promise.all(
          rowsResult.results.map((row) => mapCounterpartyRow(db, cipher, row))
        ),
        total: countRow?.total ?? 0,
      };
    },
  };
}
