import { Hono } from "hono";
import { z } from "zod";
import { createAssetProfilesRepository } from "@/db/repositories";
import { badRequestParams, notFound } from "@/lib/errors";
import type { Env } from "@/types/env";

// Public, UNAUTHENTICATED host for the token metadata URI. Returns only the
// cached public_metadata projection (never issuance_metadata), as the safe
// subset wallets and explorers consume. Mounted outside the v1 auth group.

const publicTokenMetadata = new Hono<{ Bindings: Env }>();

// Solana mint addresses are base58, 32-44 chars. Keep this loose; resolution
// failure simply 404s.
const mintAddressParamsSchema = z.object({
  mintAddress: z.string().min(32).max(44),
});

publicTokenMetadata.get("/:mintAddress", async (c) => {
  const params = mintAddressParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams();
  }

  const repo = createAssetProfilesRepository(c.env);
  const metadata = await repo.getPublicMetadataByMintAddress(params.data.mintAddress);

  if (!metadata) {
    throw notFound("Token metadata");
  }

  // Served as a raw metadata document (not the SuccessResponse envelope) so it
  // conforms to what off-chain token metadata consumers expect at the URI.
  return c.json(metadata);
});

export default publicTokenMetadata;
