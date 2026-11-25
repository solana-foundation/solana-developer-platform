import { z } from "zod";

/** Reserved selector namespace; these IDs are never durable ledger IDs. */
export const DISCOVERED_EARN_POSITION_PREFIX = "earn_discovered_";
const locatorSchema = z
  .object({
    strategyId: z.string().min(1).max(128),
    source: z.union([
      z.object({ walletId: z.string().min(1).max(128) }).strict(),
      z
        .object({
          ownerAddress: z
            .string()
            .min(32)
            .max(44)
            .regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
        })
        .strict(),
    ]),
  })
  .strict();

/**
 * A public selector, never authorization, ownership proof, or a stored claim.
 * Resolving it must re-authorize the source, load the strategy's retained
 * instrument metadata, and verify the live holding before preparing an exit.
 */
export type DiscoveredEarnPositionLocator = z.infer<typeof locatorSchema>;

/** Encode a validated instrument/owner selector without claiming its ownership. */
export function encodeDiscoveredEarnPositionLocator(input: DiscoveredEarnPositionLocator): string {
  return (
    DISCOVERED_EARN_POSITION_PREFIX +
    Buffer.from(JSON.stringify(locatorSchema.parse(input))).toString("base64url")
  );
}

/** Invalid or unrelated selectors return null; no embedded value is trusted. */
export function parseDiscoveredEarnPositionLocator(
  id: string
): DiscoveredEarnPositionLocator | null {
  if (!id.startsWith(DISCOVERED_EARN_POSITION_PREFIX) || id.length > 1024) return null;
  const encoded = id.slice(DISCOVERED_EARN_POSITION_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const parsed = locatorSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
