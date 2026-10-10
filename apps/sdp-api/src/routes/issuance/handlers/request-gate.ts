import type { z } from "zod";
import type { RequestGateExtraction } from "@/middleware/request-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";

/**
 * Gate extraction for issuance routes whose handler resolves its own token,
 * wallet and signer: the gate only hands over the validated body.
 *
 * @param c - Request context after body validation.
 * @returns The validated body and no pre-resolved resources.
 */
export async function extractIssuanceBody(
  c: ValidatedBodyContext<z.ZodType>
): Promise<RequestGateExtraction> {
  return { body: c.req.valid("json") as Record<string, unknown>, resolved: {} };
}

/**
 * Gate extraction for issuance routes with no request body (the handler reads
 * its path and query itself).
 *
 * @returns An empty body and no pre-resolved resources.
 */
export async function extractIssuanceNoBody(): Promise<RequestGateExtraction> {
  return { body: {}, resolved: {} };
}
