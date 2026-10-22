import { runInClusterScope } from "@sdp/rpc/scope";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { type Address, address, lamports, type MaybeAccount, signature } from "@solana/kit";
import { findSubscriptionAuthorityPda, type SubscriptionAuthority } from "@solana/subscriptions";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { transactionFailed } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import {
  type SubscriptionAuthorityTenant,
  seedAuthoritySubscription,
  seedSubscriptionAuthorityTenant,
} from "@/test/helpers/subscription-authorities";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  revokeIdleSubscriptionAuthorities,
  type SubscriptionAuthorityChain,
} from "./authority-revocation";
import type { SavedSendOutcome } from "./shared";

/**
 * The cron's handling of one revoke's outcomes (HOO-2210), over a scripted chain and real revoke
 * rows. The Surfpool suite (`recurring-payments-authority-revocation.test.ts` in
 * @sdp/api-integration) runs the revoke itself on chain.
 */

const WALLET = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const MINT = address(WELL_KNOWN_TOKENS.USDC.mints.devnet.address);
const SPONSOR = address("11111111111111111111111111111112");
const SIGNATURE = signature("5".repeat(88));
const NOW = new Date("2026-10-21T12:00:00.000Z");
const LONG_AGO = "2026-10-19T12:00:00.000Z";

/** A chain whose answers each test scripts, recording what the sweep asked of it. */
class ScriptedChain implements SubscriptionAuthorityChain {
  authorityOpen = true;
  readonly authorityReads: ("confirmed" | "finalized")[] = [];
  readonly rentReceivers: Address[] = [];
  readonly savedSendOutcomes: SavedSendOutcome[] = [];
  /** What each send does once it has saved its signature: land, or throw. */
  readonly sends: (() => void)[] = [];
  /** Throws before anything is saved, as a preflight refusal does. */
  refuseNextSend: Error | null = null;
  sendCount = 0;

  constructor(private readonly authority: Address) {}

  async readAuthority(
    authority: Address,
    commitment: "confirmed" | "finalized"
  ): Promise<MaybeAccount<SubscriptionAuthority>> {
    this.authorityReads.push(commitment);
    if (!this.authorityOpen) return { exists: false, address: authority };
    return {
      exists: true,
      address: authority,
      executable: false,
      lamports: lamports(1_000_000n),
      programAddress: address("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44"),
      space: 0n,
      data: {
        discriminator: 0,
        user: WALLET,
        tokenMint: MINT,
        payer: SPONSOR,
        bump: 255,
        initId: 1n,
      },
    };
  }

  async readSavedSend(): Promise<SavedSendOutcome> {
    const outcome = this.savedSendOutcomes.shift();
    if (outcome === undefined) throw new Error("No saved-send outcome scripted");
    return outcome;
  }

  async sendRevoke(input: Parameters<SubscriptionAuthorityChain["sendRevoke"]>[0]) {
    this.sendCount += 1;
    this.rentReceivers.push(input.rentReceiver);
    if (this.refuseNextSend) {
      const refusal = this.refuseNextSend;
      this.refuseNextSend = null;
      throw refusal;
    }
    await input.store.persistSigned({
      signature: SIGNATURE,
      signedTransaction: "AQ==",
      lastValidBlockHeight: "100",
    });
    this.sends.shift()?.();
    return SIGNATURE;
  }

  async confirm(): Promise<void> {}

  get authorityAddress(): Address {
    return this.authority;
  }
}

function sweep(chain: SubscriptionAuthorityChain, at: Date = NOW) {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    runWithSystemDatabaseIdentity("test:authority-revocation", () =>
      revokeIdleSubscriptionAuthorities(env, at, chain)
    )
  );
}

async function revocations() {
  return getDb(env).queryMany<{ status: string; signature: string | null; error: string | null }>(
    "SELECT status, signature, error FROM payment_subscription_authority_revocations ORDER BY created_at"
  );
}

/** Makes the held revoke stale for a run at NOW + 20 minutes. */
async function ageRevocations(): Promise<void> {
  await getDb(env).execute("UPDATE payment_subscription_authority_revocations SET updated_at = ?", [
    NOW.toISOString(),
  ]);
}

const LATER = new Date(NOW.getTime() + 20 * 60 * 1000);

describe("revokeIdleSubscriptionAuthorities", () => {
  let authority: Address;
  let tenant: SubscriptionAuthorityTenant;
  let chain: ScriptedChain;

  beforeAll(async () => {
    await seedTestDatabase(env);
    [authority] = await findSubscriptionAuthorityPda({ user: WALLET, tokenMint: MINT });
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    tenant = await seedSubscriptionAuthorityTenant({
      projectId: "prj_authority_revocation_service_test",
      custodyWalletId: "cwlt_authority_revocation_service_test",
      providerWalletId: "wallet_authority_revocation_service_test",
      walletAddress: WALLET,
    });
    await seedAuthoritySubscription(tenant, {
      authority,
      tokenMint: MINT,
      status: "canceled",
      changedAt: LONG_AGO,
      recurring: { status: "canceled" },
    });
    chain = new ScriptedChain(authority);
  });

  it("revokes once, naming the rent payer the authority recorded, and then has nothing to do", async () => {
    expect(await sweep(chain)).toEqual({ revoked: 1, recovered: 0, failed: 0, skipped: 0 });
    expect(chain.rentReceivers).toEqual([SPONSOR]);
    expect(await revocations()).toEqual([
      { status: "confirmed", signature: SIGNATURE, error: null },
    ]);

    expect(await sweep(chain)).toEqual({ revoked: 0, recovered: 0, failed: 0, skipped: 0 });
    expect(chain.sendCount).toBe(1);
  });

  it("confirms without sending when the authority is already gone", async () => {
    chain.authorityOpen = false;

    expect(await sweep(chain)).toMatchObject({ revoked: 1 });
    expect(chain.sendCount).toBe(0);
    expect(await revocations()).toEqual([{ status: "confirmed", signature: null, error: null }]);
  });

  it("fails a revoke refused before broadcast, and retries it after the retry window", async () => {
    chain.refuseNextSend = transactionFailed("preflight refused");

    expect(await sweep(chain)).toMatchObject({ revoked: 0, failed: 1 });
    expect(await revocations()).toEqual([
      { status: "failed", signature: null, error: "preflight refused" },
    ]);
    expect(await sweep(chain)).toMatchObject({ revoked: 0, failed: 0 });

    // The failure is stamped with the wall clock; pin it to the tick so the window is exact.
    await ageRevocations();
    expect(await sweep(chain, new Date(NOW.getTime() + 7 * 60 * 60 * 1000))).toMatchObject({
      revoked: 1,
    });
  });

  it("holds a revoke whose send may have landed, then settles it from the chain", async () => {
    chain.sends.push(() => {
      throw new Error("socket hang up");
    });

    expect(await sweep(chain)).toEqual({ revoked: 0, recovered: 0, failed: 0, skipped: 0 });
    expect(await revocations()).toEqual([
      { status: "processing", signature: SIGNATURE, error: null },
    ]);

    // Inside the stale window the sweep leaves it alone, and no second revoke is claimed.
    expect(await sweep(chain, new Date(NOW.getTime() + 60_000))).toMatchObject({ recovered: 0 });
    expect(chain.sendCount).toBe(1);

    // Past it, the saved send may still land: wait.
    await ageRevocations();
    chain.savedSendOutcomes.push("pending");
    expect(await sweep(chain, LATER)).toMatchObject({ recovered: 0 });
    expect(chain.sendCount).toBe(1);

    // It expired without landing: send it again, and it lands.
    await ageRevocations();
    chain.savedSendOutcomes.push("expired");
    expect(await sweep(chain, LATER)).toMatchObject({ recovered: 1 });
    expect(chain.sendCount).toBe(2);
    expect(chain.authorityReads.slice(-1)).toEqual(["finalized"]);
    expect(await revocations()).toEqual([
      { status: "confirmed", signature: SIGNATURE, error: null },
    ]);
  });

  it("keeps holding a recovered revoke when reading its earlier send fails", async () => {
    chain.sends.push(() => {
      throw new Error("socket hang up");
    });
    await sweep(chain);
    await ageRevocations();

    // No outcome scripted: the read throws, and the earlier send may still land.
    expect(await sweep(chain, LATER)).toMatchObject({ recovered: 0, failed: 0 });
    expect(await revocations()).toEqual([
      { status: "processing", signature: SIGNATURE, error: null },
    ]);
  });

  it("confirms a held revoke once the chain shows the authority gone at finalized", async () => {
    chain.sends.push(() => {
      throw new Error("socket hang up");
    });
    await sweep(chain);
    await ageRevocations();
    chain.authorityOpen = false;

    expect(await sweep(chain, LATER)).toMatchObject({ recovered: 1 });
    expect(chain.authorityReads.slice(-1)).toEqual(["finalized"]);
    expect(await revocations()).toEqual([
      { status: "confirmed", signature: SIGNATURE, error: null },
    ]);
  });

  it("asks the chain nothing when there is nothing to revoke", async () => {
    await getDb(env).execute("UPDATE payment_recurring_payments SET status = 'canceling'");

    expect(await sweep(chain)).toEqual({ revoked: 0, recovered: 0, failed: 0, skipped: 0 });
    expect(chain.authorityReads).toEqual([]);
  });
});
