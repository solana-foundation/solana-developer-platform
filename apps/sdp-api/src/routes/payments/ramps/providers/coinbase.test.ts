import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type {
  CounterpartyProviderAccountRow,
  PatchAccountMetadataInput,
  UpsertCounterpartyProviderAccountInput,
} from "@/db/repositories/counterparty-provider-account.repository";
import {
  type CoinbaseLinkStore,
  readStoredCoinbaseUserAuthToken,
  storeCoinbaseUserAuthToken,
} from "./coinbase";

const counterparty = {
  id: "cpty_123",
  organization_id: "org_123",
  project_id: "prj_123",
} as CounterpartyRow;

const now = () => new Date("2026-09-25T12:00:00.000Z");

/** Reversible stand-in for the custody cipher: prefixes the org so the scope is visible in assertions. */
const cipher = {
  encrypt: async (orgId: string, plaintext: string) => `enc:${orgId}:${plaintext}`,
  decrypt: async (orgId: string, ciphertext: string) => {
    const prefix = `enc:${orgId}:`;
    if (!ciphertext.startsWith(prefix)) {
      throw new Error("wrong key");
    }
    return ciphertext.slice(prefix.length);
  },
};

function row(metadata: Record<string, unknown>): CounterpartyProviderAccountRow {
  return {
    id: "cpa_1",
    organization_id: "org_123",
    project_id: "prj_123",
    counterparty_id: "cpty_123",
    provider: "coinbase",
    provider_customer_reference: "cpty_123",
    kind: "customer_link",
    external_account_reference: null,
    fiat_currency: null,
    destination_country: null,
    payment_rail: null,
    provider_status: null,
    status: "active",
    metadata,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  } as CounterpartyProviderAccountRow;
}

/**
 * In-memory link store. `racedBy` simulates a concurrent request that created the row
 * between this request's read and its upsert: the upsert then returns that row instead.
 */
function fakeStore(
  existing: CounterpartyProviderAccountRow | null,
  racedBy: CounterpartyProviderAccountRow | null = null
) {
  const calls: {
    upserts: UpsertCounterpartyProviderAccountInput[];
    patches: PatchAccountMetadataInput[];
    refused: number;
  } = {
    upserts: [],
    patches: [],
    refused: 0,
  };
  const store: CoinbaseLinkStore = {
    getProviderAccount: async () => existing,
    upsertProviderAccount: async (input) => {
      calls.upserts.push(input);
      return racedBy ?? row(input.metadata ?? {});
    },
    patchAccountMetadata: async (input) => {
      const current = (racedBy ?? existing)?.metadata ?? {};
      if (input.onlyIf !== undefined && !input.onlyIf(current)) {
        calls.refused += 1;
        return null;
      }
      calls.patches.push(input);
      return existing;
    },
  };
  return { store, calls };
}

const orderCreatedAt = "2026-09-25T12:00:00Z";

describe("readStoredCoinbaseUserAuthToken", () => {
  it("returns null when the counterparty has no Coinbase link", async () => {
    expect(
      await readStoredCoinbaseUserAuthToken(
        fakeStore(null).store,
        cipher,
        counterparty,
        "prj_123",
        now
      )
    ).toBeNull();
  });

  it("returns null for a link with no token yet", async () => {
    expect(
      await readStoredCoinbaseUserAuthToken(
        fakeStore(row({})).store,
        cipher,
        counterparty,
        "prj_123",
        now
      )
    ).toBeNull();
  });

  it("returns a token that has not expired", async () => {
    const { store } = fakeStore(
      row({
        userAuthTokenCiphertext: "enc:org_123:uat_live",
        userAuthTokenExpiresAt: "2026-11-24T12:00:00.000Z",
      })
    );
    expect(await readStoredCoinbaseUserAuthToken(store, cipher, counterparty, "prj_123", now)).toBe(
      "uat_live"
    );
  });

  it("returns null once the token has lapsed", async () => {
    const { store } = fakeStore(
      row({
        userAuthTokenCiphertext: "enc:org_123:uat_old",
        userAuthTokenExpiresAt: "2026-09-25T11:59:59.000Z",
      })
    );
    expect(
      await readStoredCoinbaseUserAuthToken(store, cipher, counterparty, "prj_123", now)
    ).toBeNull();
  });

  it("treats unparseable metadata as no token rather than failing the quote", async () => {
    const { store } = fakeStore(row({ userAuthTokenCiphertext: 42 }));
    expect(
      await readStoredCoinbaseUserAuthToken(store, cipher, counterparty, "prj_123", now)
    ).toBeNull();
  });

  it("treats a ciphertext the cipher cannot open as no token, so the buyer re-verifies", async () => {
    const { store } = fakeStore(
      row({
        userAuthTokenCiphertext: "enc:org_other:uat_x",
        userAuthTokenExpiresAt: "2026-11-24T12:00:00.000Z",
      })
    );
    expect(
      await readStoredCoinbaseUserAuthToken(store, cipher, counterparty, "prj_123", now)
    ).toBeNull();
  });
});

describe("storeCoinbaseUserAuthToken", () => {
  it("creates the link with the token and a 60-day expiry when there is none", async () => {
    const { store, calls } = fakeStore(null);

    await storeCoinbaseUserAuthToken(
      store,
      cipher,
      counterparty,
      "prj_123",
      "uat_new",
      orderCreatedAt
    );

    expect(calls.patches).toHaveLength(0);
    expect(calls.upserts).toEqual([
      {
        organizationId: "org_123",
        projectId: "prj_123",
        counterpartyId: "cpty_123",
        provider: "coinbase",
        providerCustomerReference: "cpty_123",
        metadata: {
          userAuthTokenCiphertext: "enc:org_123:uat_new",
          userAuthTokenExpiresAt: "2026-11-24T12:00:00.000Z",
        },
      },
    ]);
  });

  it("keeps a stored token that expires later than the one being written, so a slow request cannot roll a newer token back", async () => {
    const { store, calls } = fakeStore(
      row({
        userAuthTokenCiphertext: "enc:org_123:uat_newest",
        userAuthTokenExpiresAt: "2026-11-25T00:00:00.000Z",
      })
    );

    await storeCoinbaseUserAuthToken(
      store,
      cipher,
      counterparty,
      "prj_123",
      "uat_older",
      orderCreatedAt
    );

    expect(calls.upserts).toHaveLength(0);
    expect(calls.patches).toHaveLength(0);
    expect(calls.refused).toBe(1);
  });

  it("lets a token created in the same second as the stored one land, since Coinbase's order within that second is not observable", async () => {
    const { store, calls } = fakeStore(
      row({
        userAuthTokenCiphertext: "enc:org_123:uat_same_second",
        userAuthTokenExpiresAt: "2026-11-24T12:00:00.000Z",
      })
    );

    await storeCoinbaseUserAuthToken(
      store,
      cipher,
      counterparty,
      "prj_123",
      "uat_mine",
      orderCreatedAt
    );

    expect(calls.refused).toBe(0);
    expect(calls.patches).toHaveLength(1);
  });

  it("falls through to the guarded patch when a concurrent request created the row first", async () => {
    const raced = row({
      userAuthTokenCiphertext: "enc:org_123:uat_from_the_other_request",
      userAuthTokenExpiresAt: "2026-11-24T11:00:00.000Z",
    });
    const { store, calls } = fakeStore(null, raced);

    await storeCoinbaseUserAuthToken(
      store,
      cipher,
      counterparty,
      "prj_123",
      "uat_mine",
      orderCreatedAt
    );

    expect(calls.upserts).toHaveLength(1);
    expect(calls.patches).toHaveLength(1);
    expect(calls.patches[0]?.set).toEqual({
      userAuthTokenCiphertext: "enc:org_123:uat_mine",
      userAuthTokenExpiresAt: "2026-11-24T12:00:00.000Z",
    });
  });

  it("replaces an older token on an existing link and restarts the expiry", async () => {
    const { store, calls } = fakeStore(
      row({
        userAuthTokenCiphertext: "enc:org_123:uat_old",
        userAuthTokenExpiresAt: "2026-10-01T00:00:00.000Z",
      })
    );

    await storeCoinbaseUserAuthToken(
      store,
      cipher,
      counterparty,
      "prj_123",
      "uat_newer",
      orderCreatedAt
    );

    expect(calls.upserts).toHaveLength(0);
    expect(calls.patches.map(({ onlyIf, ...patch }) => patch)).toEqual([
      {
        organizationId: "org_123",
        projectId: "prj_123",
        counterpartyId: "cpty_123",
        provider: "coinbase",
        id: "cpa_1",
        set: {
          userAuthTokenCiphertext: "enc:org_123:uat_newer",
          userAuthTokenExpiresAt: "2026-11-24T12:00:00.000Z",
        },
        unset: [],
      },
    ]);
  });
});
