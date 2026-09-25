import {
  COINBASE_USER_AUTH_TOKEN_TTL_MS,
  type CoinbaseCustomerLinkMetadata,
  coinbaseCustomerLinkMetadataSchema,
} from "@sdp/payments/ramps/providers/coinbase/counterparty";
import { getDb } from "@/db";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type {
  CounterpartyProviderAccountRow,
  CounterpartyProviderAccountsRepository,
} from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { type CustodyCipher, createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import type { Env } from "@/types/env";

/**
 * The counterparty's Coinbase customer link.
 *
 * Coinbase never mints a customer for SDP: the buyer is identified to Coinbase by
 * `partnerUserRef`, built from the counterparty id, and verified on Coinbase's own
 * screens inside the embedded order. What SDP keeps is the reusable `userAuthToken`
 * that order returns, so the next order for the same buyer skips the one-time codes.
 * The token is the only thing on the row, stored as ciphertext from the custody
 * cipher because it is a 60-day credential; the buyer's contact stays with Coinbase.
 */

/** Only what the two functions below need, so tests can pass a fake. */
export type CoinbaseLinkStore = Pick<
  CounterpartyProviderAccountsRepository,
  "getProviderAccount" | "upsertProviderAccount" | "patchAccountMetadata"
>;

function coinbaseScope(counterparty: CounterpartyRow, projectId: string) {
  return {
    organizationId: counterparty.organization_id,
    projectId,
    counterpartyId: counterparty.id,
    provider: "coinbase" as const,
  };
}

function parseLink(
  row: CounterpartyProviderAccountRow | null
): CoinbaseCustomerLinkMetadata | null {
  if (row === null) {
    return null;
  }
  // A row whose metadata does not parse is treated as no token rather than failing
  // the quote: the buyer verifies again on Coinbase's screens, which repairs it.
  const parsed = coinbaseCustomerLinkMetadataSchema.safeParse(row.metadata);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads the stored token for the buyer, or null when there is none or it has lapsed.
 *
 * A ciphertext the cipher can no longer open (a rotated key) also reads as no token:
 * the cost of that is one more verification on Coinbase's screens, where failing the
 * quote would cost the deposit.
 *
 * @param now - Clock, injectable for tests.
 */
export async function readStoredCoinbaseUserAuthToken(
  store: CoinbaseLinkStore,
  cipher: CustodyCipher,
  counterparty: CounterpartyRow,
  projectId: string,
  now: () => Date = () => new Date()
): Promise<string | null> {
  const link = parseLink(await store.getProviderAccount(coinbaseScope(counterparty, projectId)));
  if (link === null || !("userAuthTokenCiphertext" in link)) {
    return null;
  }
  if (Date.parse(link.userAuthTokenExpiresAt) <= now().getTime()) {
    return null;
  }
  try {
    return await cipher.decrypt(counterparty.organization_id, link.userAuthTokenCiphertext);
  } catch {
    return null;
  }
}

/**
 * Keeps the buyer's newest token on the counterparty's Coinbase link.
 *
 * Coinbase mints the token with the order and the newest supersedes older ones, so the
 * expiry is derived from Coinbase's own order creation time (not our clock, which cannot
 * tell which of two overlapping requests Coinbase processed last) and the patch only lands
 * when the stored token expires no later. The check runs inside the repository's row lock,
 * so two orders for one buyer cannot leave the older token behind whichever request is
 * slower; on an equal second the later write wins, since Coinbase's ordering within that
 * second is not observable. A first-time buyer's row is created by upsert; if a concurrent
 * request created it first, the write falls through to the same conditional patch.
 *
 * @param orderCreatedAt - Coinbase's `order.createdAt` for the order carrying the token.
 */
export async function storeCoinbaseUserAuthToken(
  store: CoinbaseLinkStore,
  cipher: CustodyCipher,
  counterparty: CounterpartyRow,
  projectId: string,
  userAuthToken: string,
  orderCreatedAt: string
): Promise<void> {
  const scope = coinbaseScope(counterparty, projectId);
  const metadata: CoinbaseCustomerLinkMetadata = {
    userAuthTokenCiphertext: await cipher.encrypt(counterparty.organization_id, userAuthToken),
    userAuthTokenExpiresAt: new Date(
      Date.parse(orderCreatedAt) + COINBASE_USER_AUTH_TOKEN_TTL_MS
    ).toISOString(),
  };
  const notOlderThanStored = (current: Record<string, unknown>): boolean => {
    const stored = coinbaseCustomerLinkMetadataSchema.safeParse(current);
    if (!stored.success || !("userAuthTokenExpiresAt" in stored.data)) {
      return true;
    }
    return (
      Date.parse(stored.data.userAuthTokenExpiresAt) <= Date.parse(metadata.userAuthTokenExpiresAt)
    );
  };

  let row = await store.getProviderAccount(scope);
  if (row === null) {
    // Upsert only fills gaps: when this request creates the row it carries our token
    // and we are done; when a concurrent request got there first it returns that row.
    row = await store.upsertProviderAccount({
      ...scope,
      providerCustomerReference: counterparty.id,
      metadata,
    });
    if (row.metadata.userAuthTokenCiphertext === metadata.userAuthTokenCiphertext) {
      return;
    }
  }
  await store.patchAccountMetadata({
    ...scope,
    id: row.id,
    set: metadata,
    unset: [],
    onlyIf: notOlderThanStored,
  });
}

/** Env-bound readers for the handler; the repository is the real one. */
export function readCoinbaseUserAuthToken(
  env: Env,
  counterparty: CounterpartyRow,
  projectId: string
): Promise<string | null> {
  return readStoredCoinbaseUserAuthToken(
    createPostgresCounterpartyProviderAccountsRepository(getDb(env)),
    createCustodyCipher(env),
    counterparty,
    projectId
  );
}

export function rememberCoinbaseUserAuthToken(
  env: Env,
  counterparty: CounterpartyRow,
  projectId: string,
  userAuthToken: string,
  orderCreatedAt: string
): Promise<void> {
  return storeCoinbaseUserAuthToken(
    createPostgresCounterpartyProviderAccountsRepository(getDb(env)),
    createCustodyCipher(env),
    counterparty,
    projectId,
    userAuthToken,
    orderCreatedAt
  );
}
