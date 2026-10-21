import { type Address, address } from "@solana/kit";
import {
  AccountDiscriminator,
  CURRENT_PROGRAM_VERSION,
  getPlanEncoder,
  getSubscriptionAuthorityEncoder,
  getSubscriptionDelegationEncoder,
  PlanStatus,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  ZERO_ADDRESS,
} from "@solana/subscriptions";
import { AccountState, getTokenEncoder } from "@solana-program/token-2022";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import type { StubEncodedAccount } from "@/test/helpers/cluster-rpc";

const DELEGATOR = address(TEST_SOLANA_ADDRESSES.wallet1);
const DELEGATEE = address(TEST_SOLANA_ADDRESSES.wallet2);
const PLAN_MINT = address(TEST_SOLANA_ADDRESSES.mint);
const PLAN_TERMS = { amount: 25_000_000n, periodHours: 24n } as const;

/** A plan account's four destination slots; the unused ones hold `ZERO_ADDRESS`. */
export type PlanDestinations = [Address, Address, Address, Address];

/** What a stubbed plan account shows: the fields a step's effect or a finalize reads. */
export interface StubPlan {
  owner: Address;
  destinations: PlanDestinations;
  createdAt: bigint;
  metadataUri: string;
}

/**
 * The destination slots of a plan that pays one destination.
 *
 * @param destination - The plan's destination.
 * @returns `destination` followed by three empty slots.
 */
export function soleDestination(destination: Address): PlanDestinations {
  return [destination, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS];
}

/**
 * A plan account as the subscriptions program stores it, encoded with the program's own layout.
 * Its owner is its only puller, as SDP creates every plan.
 *
 * @param plan - The plan's owner, destinations, creation time and metadata URI.
 * @returns The account, owned by the subscriptions program.
 */
export function planAccount(plan: StubPlan): StubEncodedAccount {
  return {
    owner: SUBSCRIPTIONS_PROGRAM_ADDRESS,
    data: new Uint8Array(
      getPlanEncoder().encode({
        discriminator: AccountDiscriminator.Plan,
        owner: plan.owner,
        bump: 255,
        status: PlanStatus.Active,
        data: {
          planId: 1001n,
          mint: PLAN_MINT,
          terms: { ...PLAN_TERMS, createdAt: plan.createdAt },
          endTs: 0n,
          destinations: plan.destinations,
          pullers: [plan.owner, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS],
          metadataUri: plan.metadataUri,
        },
      })
    ),
  };
}

/**
 * A subscription delegation as the subscriptions program stores it.
 *
 * @param expiresAtTs - The delegation's expiry: 0 while active, the period's end once canceled.
 * @returns The account, owned by the subscriptions program.
 */
export function subscriptionDelegationAccount(expiresAtTs: bigint): StubEncodedAccount {
  return {
    owner: SUBSCRIPTIONS_PROGRAM_ADDRESS,
    data: new Uint8Array(
      getSubscriptionDelegationEncoder().encode({
        header: {
          discriminator: AccountDiscriminator.SubscriptionDelegation,
          version: CURRENT_PROGRAM_VERSION,
          bump: 255,
          delegator: DELEGATOR,
          delegatee: DELEGATEE,
          payer: DELEGATOR,
          initId: 1n,
        },
        terms: { ...PLAN_TERMS, createdAt: 1_770_000_000n },
        amountPulledInPeriod: 0n,
        currentPeriodStartTs: 1_770_000_000n,
        expiresAtTs,
      })
    ),
  };
}

/**
 * A subscription authority as the subscriptions program stores it.
 *
 * @param input - Whose authority it is.
 * @param input.user - The wallet the authority acts for.
 * @param input.tokenMint - The mint it covers.
 * @returns The account, owned by the subscriptions program.
 */
export function subscriptionAuthorityAccount(input: {
  user: Address;
  tokenMint: Address;
}): StubEncodedAccount {
  return {
    owner: SUBSCRIPTIONS_PROGRAM_ADDRESS,
    data: new Uint8Array(
      getSubscriptionAuthorityEncoder().encode({
        discriminator: AccountDiscriminator.SubscriptionAuthority,
        user: input.user,
        tokenMint: input.tokenMint,
        payer: input.user,
        bump: 255,
        initId: 1n,
      })
    ),
  };
}

/**
 * A token account with no extensions, encoded with the token-2022 layout (which the legacy
 * token program shares for the base account).
 *
 * @param input - The account's fields.
 * @param input.programAddress - The token program owning the account.
 * @param input.mint - The account's mint.
 * @param input.owner - The account's owner.
 * @param input.delegate - The approved delegate, or null when none is approved.
 * @returns The account, owned by `programAddress`.
 */
export function tokenAccount(input: {
  programAddress: Address;
  mint: Address;
  owner: Address;
  delegate: Address | null;
}): StubEncodedAccount {
  return {
    owner: input.programAddress,
    data: new Uint8Array(
      getTokenEncoder().encode({
        mint: input.mint,
        owner: input.owner,
        amount: 100_000_000n,
        delegate: input.delegate,
        state: AccountState.Initialized,
        isNative: null,
        delegatedAmount: input.delegate === null ? 0n : 100_000_000n,
        closeAuthority: null,
        extensions: null,
      })
    ),
  };
}
