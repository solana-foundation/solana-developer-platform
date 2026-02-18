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

const normalizeForFingerprint = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForFingerprint);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(source)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nestedValue]) => [key, normalizeForFingerprint(nestedValue)])
    );
  }

  return value;
};

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
