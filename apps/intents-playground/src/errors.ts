import { ServiceError } from "@/api";

/// A service error with its findings or its program logs.
export function describe(error: unknown): string {
  if (!(error instanceof ServiceError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const details = error.details as { rendered?: string; logs?: string[] } | null;
  const extra = details?.rendered ?? details?.logs?.slice(-8).join("\n");

  return extra === undefined ? error.message : `${error.message}\n\n${extra}`;
}
