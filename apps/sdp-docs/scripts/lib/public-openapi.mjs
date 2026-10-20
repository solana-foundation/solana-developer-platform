export const PUBLIC_TAG_SLUGS = new Set([
  "health",
  // API-key management answers a signed-in person only (HOO-2099), so the
  // public document carries no "api-keys" family; keys are made in the dashboard.
  "wallets",
  "projects",
  "issuance",
  "payments",
  "compliance",
  "asset-profiles",
  // A family renders only when the OpenAPI document for the build's release
  // channel carries it (SDP_RELEASE_CHANNEL; see createPublicOpenApiDocument).
  // "earn" returns with EARN_PUBLIC_SURFACE_PUBLISHED (apps/sdp-api/src/openapi/spec.ts), PRO-2038.
]);

export const POSTMAN_COLLECTION_ROUTE = "/docs/postman/collection.json";
export const POSTMAN_COLLECTION_FILENAME =
  "solana-developer-platform-public.postman_collection.json";
export const POSTMAN_COLLECTION_PUBLIC_PATH = `/postman/${POSTMAN_COLLECTION_FILENAME}`;

export const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const isPublicTag = (tagName) => PUBLIC_TAG_SLUGS.has(slugify(tagName));

export const getPrimaryTagName = (operation) =>
  Array.isArray(operation?.tags) && operation.tags.length > 0 ? String(operation.tags[0]) : null;

export const isPublicOperation = (operation) => {
  const primaryTag = getPrimaryTagName(operation);
  return primaryTag !== null && isPublicTag(primaryTag);
};
