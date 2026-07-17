import { normalizeForFingerprint } from "@/lib/idempotency";

export interface IdempotencyContext {
  tokenId: string;
  operation: string;
  mode: string;
  params: unknown;
}

export interface IdempotencyMetadata {
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
}

export const buildIdempotencyFingerprint = (input: IdempotencyContext): string =>
  JSON.stringify({
    operation: input.operation,
    mode: input.mode,
    tokenId: input.tokenId,
    params: normalizeForFingerprint(input.params),
  });

export const buildIdempotencyMetadata = (
  idempotencyKey: string | null | undefined,
  context: IdempotencyContext
): IdempotencyMetadata => {
  if (!idempotencyKey) {
    return {};
  }

  return {
    idempotencyKey,
    idempotencyFingerprint: buildIdempotencyFingerprint(context),
  };
};
