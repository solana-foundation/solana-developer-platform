export const PUBLIC_TAG_SLUGS = new Set([
  "health",
  "api-keys",
  "wallets",
  "projects",
  "issuance",
  "payments",
  "compliance",
  "asset-profiles",
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
