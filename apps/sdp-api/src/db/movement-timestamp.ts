/**
 * The single definition of the Earn movement ledger's timestamp shape, for BOTH
 * the write path and every read that compares against it (PRO-1669).
 *
 * `earn_program_movements.occurred_at` is TEXT and sorts lexicographically, and it
 * only sorts CHRONOLOGICALLY because `sdp_iso_now()` emits a fixed width
 * (`YYYY-MM-DDTHH:MM:SS.mmmZ`). Anything compared against it must have exactly that
 * width, or the comparison is subtly wrong rather than merely imprecise:
 * `'2026-09-01T00:00:00.000Z' < '2026-09-01T00:00:00Z'` is TRUE in Postgres,
 * because '.' sorts below 'Z'. A caller asking for August with the idiomatic
 * `2026-09-01T00:00:00Z` upper bound would therefore pull the boundary movement
 * into August AND lose it from September — a period misattribution in a money
 * statement, served as a 200 with no warning.
 *
 * Returns null for an unparseable value so each caller can choose: the write path
 * substitutes the observation time (a movement with a malformed timestamp is still
 * real money that must be recorded), while a read filter leaves the value alone so
 * it fails visibly rather than silently widening the window.
 *
 * Lives here, beside `postgres-utils`, rather than in the repositories barrel: it
 * is a pure string function describing a STORAGE format, and routing it through the
 * barrel would drag every repository into the module graph of anything that needs
 * it — which in turn forces every test that mocks `@/db/repositories` to stub a
 * function that touches no database.
 */
export function toMovementTimestamp(raw: string): string | null {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
