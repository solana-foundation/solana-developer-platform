/**
 * Whether the public OpenAPI document carries the Earn family. Everything
 * partner-facing derives from that document: api.solana.com/openapi.json and
 * Swagger UI, the generated API reference, the Postman collection, the
 * playground catalog and the AI discovery files. Held false until launch
 * (PRO-2038): Earn is feature-complete but not announced, so partners must not
 * discover it yet. Flipping this back is a PRO-1872 security sign-off PR
 * (routes/earn/CLAUDE.md, "Public OpenAPI promotion"); spec.test.ts pins both
 * states.
 *
 * The unified transaction list follows the same flip at its unfiltered default
 * (routes/transactions/publication.ts): while this is false, a request that
 * omits the module filter never returns held-back rows, so the responses a
 * public-contract client sees are exactly the ones the published response
 * schema describes. Explicitly requested held-back modules stay reachable for
 * authorized callers — the runtime permission matrix is unchanged.
 */
export const EARN_PUBLIC_SURFACE_PUBLISHED = false;
