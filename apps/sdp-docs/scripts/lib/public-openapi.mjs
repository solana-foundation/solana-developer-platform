export const POSTMAN_COLLECTION_ROUTE = "/docs/postman/collection.json";
export const POSTMAN_COLLECTION_FILENAME =
  "solana-developer-platform-public.postman_collection.json";
export const POSTMAN_COLLECTION_PUBLIC_PATH = `/postman/${POSTMAN_COLLECTION_FILENAME}`;

export const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The API family an operation belongs to: its first tag. The generated document is
 * the public one for the build's release channel (`createPublicOpenApiDocument` in
 * apps/sdp-api/src/openapi/spec.ts), so every family it carries is published. An
 * untagged operation fails the build rather than silently leaving the reference and
 * the Postman collection.
 *
 * @param {{ tags?: unknown }} operation - An OpenAPI operation, or the reference's parsed copy.
 * @param {string} label - `METHOD /path`, named in the error.
 * @returns {string} The family's tag name.
 */
export const getOperationFamily = (operation, label) => {
  if (!Array.isArray(operation.tags) || operation.tags.length === 0) {
    throw new Error(`${label} has no tag, so it belongs to no API family`);
  }
  return String(operation.tags[0]);
};
