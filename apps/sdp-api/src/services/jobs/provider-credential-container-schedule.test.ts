// Uses the production scan-owner migration in the test database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type {
  CredentialSecretStore,
  ListCredentialSecretVersionsParams,
} from "@/services/credential-secret-store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { scanGcpCredentialContainers } from "./provider-credential-container-cleanup";

const ORG = "org_scan_schedule_prototype";
const USER = "usr_scan_schedule_prototype";
const NOW = new Date("2030-01-01T10:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeGcp() {
  const versions = new Map<string, "ENABLED" | "DESTROYED">();
  const listVersions = vi.fn(async ({ secretRef }: ListCredentialSecretVersionsParams) => ({
    versions: [...versions]
      .filter(([name]) => name.startsWith(`${secretRef}/versions/`))
      .map(([secretVersionRef, state]) => ({ secretVersionRef, state })),
  }));
  const secrets: CredentialSecretStore = {
    storageBackend: "gcp_secret_manager",
    predictFirstVersionRef: () => null,
    write: async () => {
      throw new Error("No payload writes in a scheduling test");
    },
    read: async () => {
      throw new Error("No payload reads in a scheduling test");
    },
    listVersions,
    destroyVersion: async ({ secretVersionRef }) => {
      if (!versions.has(secretVersionRef)) throw new Error("Missing GCP version");
      versions.set(secretVersionRef, "DESTROYED");
    },
  };
  return { versions, listVersions, secrets };
}

async function seedContainer(suffix: string, due = NOW): Promise<string> {
  const id = `pcred_scan_schedule_${suffix}`;
  const parent = `projects/p/secrets/sdp-provider-credentials-${id}`;
  await getDb(env).execute(
    `INSERT INTO provider_credentials
       (id, organization_id, provider, label, scope, source, storage_backend,
        secret_ref, secret_version_ref, status, created_by, secret_next_scan_at)
     VALUES (?, ?, 'privy', 'Schedule prototype', 'organization', 'stored',
             'gcp_secret_manager', ?, ?, 'pending', ?, ?::timestamptz)`,
    [id, ORG, parent, `${parent}/versions/1`, USER, due.toISOString()]
  );
  return parent;
}

describe("single-column container scan scheduling", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).execute(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Schedule prototype', 'scan-schedule-prototype', 'enterprise', 'active')",
      [ORG]
    );
    await getDb(env).execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'scan-schedule-prototype@example.test', 1, 'active')",
      [USER]
    );
  });

  it("scans a due container, skips it before the next interval, then finds a later orphan", async () => {
    const gcp = fakeGcp();
    const parent = await seedContainer("due");
    gcp.versions.set(`${parent}/versions/1`, "ENABLED");
    gcp.versions.set(`${parent}/versions/2`, "ENABLED");

    await scanGcpCredentialContainers(env, () => gcp.secrets, { now: NOW });
    expect(gcp.versions.get(`${parent}/versions/2`)).toBe("DESTROYED");
    gcp.versions.set(`${parent}/versions/3`, "ENABLED");
    await scanGcpCredentialContainers(env, () => gcp.secrets, { now: later(1) });
    expect(gcp.versions.get(`${parent}/versions/3`)).toBe("ENABLED");
    await scanGcpCredentialContainers(env, () => gcp.secrets, { now: later(5) });
    expect(gcp.versions.get(`${parent}/versions/3`)).toBe("DESTROYED");
    expect(gcp.versions.get(`${parent}/versions/1`)).toBe("ENABLED");
  });

  it("continues past a failed container and does not starve later containers in a bounded batch", async () => {
    const gcp = fakeGcp();
    const first = await seedContainer("a", later(-2));
    const second = await seedContainer("b", later(-1));
    const third = await seedContainer("c");
    for (const parent of [first, second, third])
      gcp.versions.set(`${parent}/versions/2`, "ENABLED");
    gcp.listVersions.mockRejectedValueOnce(new Error("First container unavailable"));

    const result = await scanGcpCredentialContainers(env, () => gcp.secrets, {
      now: NOW,
      limit: 2,
    });

    expect(result).toMatchObject({ scanned: [second], failed: [first] });
    expect(gcp.versions.get(`${third}/versions/2`)).toBe("ENABLED");
    expect(
      await scanGcpCredentialContainers(env, () => gcp.secrets, { now: NOW, limit: 2 })
    ).toMatchObject({ scanned: [third], failed: [] });
    expect(gcp.versions.get(`${third}/versions/2`)).toBe("DESTROYED");
  });

  it("retries without the first worker finishing and ignores that worker's late completion", async () => {
    const gcp = fakeGcp();
    const parent = await seedContainer("interrupted");
    gcp.versions.set(`${parent}/versions/2`, "ENABLED");
    const started = deferred();
    const release = deferred();
    gcp.listVersions.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      throw new Error("First worker never completed its GCP read");
    });
    const first = scanGcpCredentialContainers(env, () => gcp.secrets, { now: NOW });
    try {
      await started.promise;
      expect(
        await scanGcpCredentialContainers(env, () => gcp.secrets, { now: later(1) })
      ).toMatchObject({ scanned: [], failed: [] });
      // No completion from the first worker is needed to make the location due again.
      expect(
        await scanGcpCredentialContainers(env, () => gcp.secrets, { now: later(5) })
      ).toMatchObject({ scanned: [parent], failed: [] });
    } finally {
      release.resolve();
      await first;
    }
    expect((await first).failed).toEqual([parent]);
    expect(gcp.versions.get(`${parent}/versions/2`)).toBe("DESTROYED");
    gcp.versions.set(`${parent}/versions/3`, "ENABLED");
    await scanGcpCredentialContainers(env, () => gcp.secrets, { now: later(6) });
    expect(gcp.versions.get(`${parent}/versions/3`)).toBe("ENABLED");
    await scanGcpCredentialContainers(env, () => gcp.secrets, { now: later(10) });
    expect(gcp.versions.get(`${parent}/versions/3`)).toBe("DESTROYED");
  });

  it("admits one of two workers that both selected the same due owner", async () => {
    const gcp = fakeGcp();
    const parent = await seedContainer("concurrent");
    gcp.versions.set(`${parent}/versions/2`, "ENABLED");
    const db = getDb(env);
    const queryMany = db.queryMany.bind(db);
    const bothSelected = deferred();
    let selected = 0;
    // Hold two real PostgreSQL SELECT replies at the DB transport seam.
    // Rows and competing UPDATE statements are never fabricated.
    vi.spyOn(db, "queryMany").mockImplementation(
      async <T>(query: string, params?: readonly unknown[]) => {
        const rows = await queryMany<T>(query, params);
        if (query.includes("secret_next_scan_at")) {
          if (++selected === 2) bothSelected.resolve();
          await bothSelected.promise;
        }
        return rows;
      }
    );

    const results = await Promise.all([
      scanGcpCredentialContainers(env, () => gcp.secrets, { now: NOW }),
      scanGcpCredentialContainers(env, () => gcp.secrets, { now: NOW }),
    ]);

    expect(results.flatMap((result) => result.scanned)).toEqual([parent]);
    expect(gcp.versions.get(`${parent}/versions/2`)).toBe("DESTROYED");
  });

  it("does not advance unstarted containers when the job admission budget ends", async () => {
    const gcp = fakeGcp();
    const first = await seedContainer("budget_a", later(-1));
    const second = await seedContainer("budget_b");
    for (const parent of [first, second]) gcp.versions.set(`${parent}/versions/2`, "ENABLED");
    expect(
      await scanGcpCredentialContainers(env, () => gcp.secrets, {
        now: NOW,
        deadlineMs: performance.now() - 1,
      })
    ).toMatchObject({ scanned: [], failed: [], deadlineReached: true });

    const deadline = performance.now() + 100_000;
    gcp.listVersions.mockImplementationOnce(async () => {
      vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
      return { versions: [{ secretVersionRef: `${first}/versions/2`, state: "ENABLED" }] };
    });
    expect(
      await scanGcpCredentialContainers(env, () => gcp.secrets, {
        now: NOW,
        deadlineMs: deadline,
      })
    ).toMatchObject({ scanned: [], failed: [], deadlineReached: true });
    vi.restoreAllMocks();
    expect(gcp.versions.get(`${second}/versions/2`)).toBe("ENABLED");
    expect(await scanGcpCredentialContainers(env, () => gcp.secrets, { now: NOW })).toMatchObject({
      scanned: [second],
      failed: [],
    });
    expect(gcp.versions.get(`${second}/versions/2`)).toBe("DESTROYED");
  });

  it.each([true, false])(
    "recovers after losing the scheduling UPDATE response (committed: %s)",
    async (committed) => {
      const gcp = fakeGcp();
      const parent = await seedContainer("update_reply");
      gcp.versions.set(`${parent}/versions/2`, "ENABLED");
      const db = getDb(env);
      const execute = db.execute.bind(db);
      vi.spyOn(db, "execute").mockImplementationOnce(async (sql, params) => {
        if (committed) await execute(sql, params);
        throw new Error("Scheduling UPDATE response lost");
      });

      await expect(
        scanGcpCredentialContainers(env, () => gcp.secrets, { now: NOW })
      ).resolves.toMatchObject({ failed: [parent] });
      expect(gcp.versions.get(`${parent}/versions/2`)).toBe("ENABLED");
      expect(await scanGcpCredentialContainers(env, () => gcp.secrets, { now: NOW })).toMatchObject(
        {
          scanned: committed ? [] : [parent],
          failed: [],
        }
      );
      await scanGcpCredentialContainers(env, () => gcp.secrets, { now: later(5) });
      expect(gcp.versions.get(`${parent}/versions/2`)).toBe("DESTROYED");
    }
  );

  it("keeps scheduling on the retired owner after rotation and organization soft deletion", async () => {
    const gcp = fakeGcp();
    const parent = await seedContainer("retired_owner");
    await getDb(env).execute(
      "UPDATE provider_credentials SET status = 'retired', secret_retention_expires_at = '2099-01-01T00:00:00.000Z' WHERE secret_ref = ?",
      [parent]
    );
    await getDb(env).execute(
      `INSERT INTO provider_credentials
         (id, organization_id, provider, label, scope, source, storage_backend,
          secret_ref, secret_version_ref, status, created_by, credential_version, rotated_from_provider_credential_id)
       VALUES ('pcred_scan_schedule_current', ?, 'privy', 'Current', 'organization', 'stored',
               'gcp_secret_manager', ?, ?, 'active', ?, 2, 'pcred_scan_schedule_retired_owner')`,
      [ORG, parent, `${parent}/versions/2`, USER]
    );
    await getDb(env).execute("UPDATE organizations SET status = 'deleted' WHERE id = ?", [ORG]);
    for (const version of [1, 2, 3]) gcp.versions.set(`${parent}/versions/${version}`, "ENABLED");

    expect(await scanGcpCredentialContainers(env, () => gcp.secrets, { now: NOW })).toMatchObject({
      scanned: [parent],
      failed: [],
    });

    expect([...gcp.versions.values()]).toEqual(["ENABLED", "ENABLED", "DESTROYED"]);
  });

  it("does not start GCP when the scheduling UPDATE returns after the admission deadline", async () => {
    const gcp = fakeGcp();
    const parent = await seedContainer("slow_update");
    gcp.versions.set(`${parent}/versions/2`, "ENABLED");
    const db = getDb(env);
    const execute = db.execute.bind(db);
    const deadline = performance.now() + 100_000;
    vi.spyOn(db, "execute").mockImplementationOnce(async (sql, params) => {
      const changed = await execute(sql, params);
      vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
      return changed;
    });

    expect(
      await scanGcpCredentialContainers(env, () => gcp.secrets, {
        now: NOW,
        deadlineMs: deadline,
      })
    ).toMatchObject({ scanned: [], failed: [], deadlineReached: true });
    vi.restoreAllMocks();
    expect(gcp.versions.get(`${parent}/versions/2`)).toBe("ENABLED");
    await scanGcpCredentialContainers(env, () => gcp.secrets, { now: later(5) });
    expect(gcp.versions.get(`${parent}/versions/2`)).toBe("DESTROYED");
  });
});
