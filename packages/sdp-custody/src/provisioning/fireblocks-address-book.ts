import { FIREBLOCKS_ADDRESS_STATUSES, type FireblocksAddressStatus } from "@sdp/types/fireblocks";
import { z } from "zod";
import { SigningError } from "#/signing";
import { assertHttpsBaseUrl } from "./common";
import { fireblocksRequest } from "./fireblocks-http";
import type { FireblocksTransferAccess } from "./fireblocks-transfers";
import type { CustodyProvisioningRuntime } from "./runtime";

export interface FireblocksAddressEntry {
  walletId: string;
  walletType: "EXTERNAL_WALLET" | "INTERNAL_WALLET";
  name: string;
  assetId: string;
  address: string;
  status: FireblocksAddressStatus;
  activationTime: string | null;
}
const bookSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      assets: z.array(
        z.object({
          id: z.string(),
          address: z.string(),
          status: z.enum(FIREBLOCKS_ADDRESS_STATUSES),
          activationTime: z.string().nullish(),
        })
      ),
    })
  )
  .max(10_000);
const books = new Map<
  string,
  { expires: number; pending: boolean; entries: Promise<FireblocksAddressEntry[]> }
>();
function config(access: FireblocksTransferAccess) {
  return {
    ...access,
    apiBaseUrl: assertHttpsBaseUrl(access.apiBaseUrl ?? "https://api.fireblocks.io", "Fireblocks"),
  };
}
function cacheKey(access: FireblocksTransferAccess) {
  return `${access.apiBaseUrl}:${access.apiKey}`;
}
export function invalidateFireblocksAddressBook(access: FireblocksTransferAccess) {
  books.delete(cacheKey(config(access)));
}
function invalid(): never {
  throw new SigningError("Invalid Fireblocks address book response", "NETWORK_ERROR");
}
function parseBook(
  value: unknown,
  walletType: FireblocksAddressEntry["walletType"]
): FireblocksAddressEntry[] {
  const parsed = bookSchema.safeParse(value);
  if (!parsed.success) return invalid();
  return parsed.data.flatMap((wallet) =>
    wallet.assets.map((asset) => ({
      walletId: wallet.id,
      walletType,
      name: wallet.name.slice(0, 200),
      assetId: asset.id,
      address: asset.address,
      status: asset.status,
      activationTime: asset.activationTime ?? null,
    }))
  );
}
/** Two independent reads, shared across concurrent checks; failed reads are never cached. */
export async function readFireblocksAddressBook(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  fresh = false
): Promise<FireblocksAddressEntry[]> {
  const credentials = config(access);
  const key = cacheKey(credentials);
  let cached = books.get(key);
  if (!cached || (!cached.pending && (fresh || cached.expires <= runtime.now()))) {
    if (books.size >= 100) {
      // SAFETY: the size check guarantees a first entry; this synchronous read cannot interleave with another eviction.
      books.delete(books.keys().next().value as string);
    }
    const entries = Promise.all([
      fireblocksRequest(runtime, {
        ...credentials,
        method: "GET",
        uri: "/v1/external_wallets",
      }).then((value) => parseBook(value, "EXTERNAL_WALLET")),
      fireblocksRequest(runtime, {
        ...credentials,
        method: "GET",
        uri: "/v1/internal_wallets",
      }).then((value) => parseBook(value, "INTERNAL_WALLET")),
    ]).then(([external, internal]) => [...external, ...internal]);
    cached = { expires: runtime.now() + 30_000, pending: true, entries };
    books.set(key, cached);
    const current = cached;
    void entries.then(
      () => {
        current.pending = false;
        current.expires = runtime.now() + 30_000;
      },
      () => {
        if (books.get(key) === current) books.delete(key);
      }
    );
  }
  return cached.entries;
}
