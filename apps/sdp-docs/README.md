# SDP Docs

Public documentation for the Solana Developer Platform, built with Next.js and Fumadocs and served at https://platform.solana.com/docs. Production traffic reaches this app through sdp-web's `/docs` proxy.

The docs describe the supported public surface only: the guides, the generated API reference, the Postman collection and the AI discovery files all follow the public OpenAPI document. Design tokens, layout and page-shell rules live in [`CLAUDE.md`](./CLAUDE.md).

## Local development

Requires Node.js 24.15+ and pnpm 10.16+. From the repo root:

```bash
pnpm install
pnpm dev:docs   # docs only, http://localhost:3001; needs no Doppler session or running API
```

`pnpm dev:docs` regenerates the API reference and AI files from the OpenAPI source before starting, so it does not need the API server.

## How the site is put together

| Path | What it holds |
| --- | --- |
| `content/docs/**/*.mdx` | Every page. The catch-all route `src/app/docs/[[...slug]]/page.tsx` renders them; no per-page route is needed. |
| `content/docs/meta.json` and each folder's `meta.json` | Sidebar order. Hand-maintained, except `reference/api/meta.json`. `---Label---` entries are section separators. |
| `content/docs/reference/api/` | Generated API reference (gitignored except `index.mdx` and `meta.json`). |
| `content/unpublished/` | Pages kept in the repo but not built or served. |
| `src/components/docs-shell/home.tsx` | The `/docs` landing page. It is TSX, so search does not index it. |
| `scripts/lib/redirects.mjs` | Redirects for retired URLs, served by `next.config.mjs`. |
| `public/` | Images, provider-onboarding PDFs and the committed generated files below. |

MDX pages can use `Callout`, `Steps`/`Step`, `Cards`/`Card` and `Tabs`/`Tab` (import the first three from `fumadocs-ui/components/*`), plus the registered `HowItWorks`/`Step`/`StepPanel` and `EnvConfigurator` components.

## Adding, moving or removing a page

1. Add `content/docs/<section>/<page>.mdx` with `title` and `description` frontmatter (optionally `icon: <LucideName>`).
2. List it in that section's `meta.json`.
3. Link to other pages with `/docs/...` paths. Raw `<img>` tags use `/docs/images/...`; Markdown images can use `/images/...`.
4. When you delete or rename a page, add a redirect for the old URL to `scripts/lib/redirects.mjs`.
5. To take a page down without deleting it, follow "Unpublishing a Page" in `CLAUDE.md`.

## Generated files

Never hand-edit these. Regenerate them, then commit the result; CI regenerates and fails on any diff under `public/`.

| Command (from `apps/sdp-docs`) | Writes |
| --- | --- |
| `pnpm generate:api` | `content/docs/reference/api/**` and `public/postman/*.postman_collection.json`, from the public OpenAPI document built by `apps/sdp-api` |
| `pnpm generate:ai` | `public/llms.txt` and `public/llms-full.txt`, from the docs navigation |

`PUBLIC_TAG_SLUGS` in `scripts/lib/public-openapi.mjs` must list exactly the families the public OpenAPI document publishes. Earn is held out of every public surface until launch (PRO-2038).

When two branches both change `llms-full.txt`, rebase and rerun both generators instead of resolving the conflict by hand.

## Checks

```bash
pnpm --filter sdp-docs check:links   # internal links, root nav entries, live external URLs
pnpm --filter sdp-docs build         # regenerates everything, then builds
pnpm --filter sdp-docs typecheck
```

## Writing guidelines

- Write for external developers; assume no knowledge of SDP internals.
- Cite only endpoints in the public API reference.
- Show complete, working requests with real ID prefixes (`cwlt_`, `cpty_`, ...).
- Link the API reference page for every endpoint family a guide uses.
