import { z } from "zod";

/**
 * A path segment that could be a pay link's token: the API mints 16 characters of letters,
 * digits and `-`. The bound is looser than that, so a longer token minted later still opens,
 * but anything else is answered 404 without spending a read of the shared per-address budget.
 */
export const payTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
