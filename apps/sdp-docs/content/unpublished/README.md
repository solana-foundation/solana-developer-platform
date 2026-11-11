# Unpublished docs

The site and public generators read only `content/docs`. Drafts in this
directory stay out of search, the sitemap, Markdown routes and AI resources.

The Earn Treasury and provider-integration guides describe internal
operations. They remain here because those routes are outside the supported
public API contract.
Public Earn guides live in `content/docs/earn` and use the normal
`module: earn` release-channel gate. API reference pages regenerate from
the public OpenAPI document with `pnpm --filter sdp-docs generate:api`.
