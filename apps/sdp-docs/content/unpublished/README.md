# Unpublished docs

The site and public generators read only `content/docs`. Drafts in this
directory stay out of search, the sitemap, Markdown routes and AI resources.

Provider-integration notes and product drafts stay here until ready for
publication. Treasury and Embedded Yield use the same core Earn API.
Public Earn guides live in `content/docs/earn` and use the normal
`module: earn` release-channel gate. API reference pages regenerate from
the public OpenAPI document with `pnpm --filter sdp-docs generate:api`.
