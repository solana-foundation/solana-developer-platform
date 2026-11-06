# Earn docs authoring

These files are private source drafts. The site reads only `content/docs`, so
they do not enter search, the sitemap, Markdown routes, Postman, or AI resources.
`module: earn` also preserves the module's publication gate when guides move.

## Review

- `earn/index.mdx`: overview and the two ways to build.
- `earn/quickstart.mdx`: a sandbox deposit with API requests or the backend module.
- `earn/concepts.mdx`: key terms, shares, signing, and how movements settle.
- `earn/strategies.mdx`: the catalog, availability, quote policies, and eligibility.
- `earn/deposits.mdx`: every deposit request and response, in cURL and TypeScript.
- `earn/balances.mdx`: positions, movements, earnings, and pagination.
- `earn/withdrawals.mdx`: instant withdrawals, provider orders, and withdrawal requests.
- `guides/embedded-yield.mdx`: the full integration, module map, and go-live checklist.
- `earn/treasury.mdx`: the internal custody wallet flow.
- `earn/integration-details.mdx`: quote floors, sponsorship, swaps, retries, and errors.
- `reference/api/earn`: generated reference for all implemented Earn routes.

Regenerate the reference with:

```bash
pnpm --filter sdp-docs generate:earn-preview
pnpm --filter sdp-docs check:earn-drafts
```

The preview uses the existing reference renderer and internal OpenAPI source.
It writes only an ignored API intermediate and this unpublished reference
directory. Each operation has its grants, schemas, examples, and source-owned
group. Routes outside the prospective partner surface carry an internal notice.
It does not change the public document or its publication flag.

`check:earn-drafts` also checks the Markdown that agents receive. Every guide
and reference page must preserve its text, code, and code labels, include Earn's
development notice, and remove presentation markup. Tabbed steps become ordered
text sections; internal-operation notices remain explicit.

The Quickstart has one path: the Earn API through a small request helper. The
dashboard's generated module is documented in the Embedded Yield guide.

## Vercel branch preview

The docs build includes Earn only when both Vercel system values match:

| Setting                 | Required value |
| ----------------------- | -------------- |
| `VERCEL_ENV`            | `preview`      |
| `VERCEL_GIT_COMMIT_REF` | `earn-docs`    |

Production, other branches, and normal local builds keep Earn unpublished.
The preview stages the nine partner guides and renders only the prospective
partner API operations. Treasury and Programs stay excluded. Preview search,
Markdown, Postman and AI resources use that same staged surface. Search engines
receive `X-Robots-Tag: noindex, nofollow`.

Staged files stay in the deployment checkout so Markdown routes can read them.
The next build clears marked staging before regenerating the normal artifacts.
Do not commit staged files or change `EARN_PUBLIC_SURFACE_PUBLISHED` to enable
a preview. `pnpm --filter sdp-docs build` owns this workflow.

## Publication

Content readiness is tracked in PRO-2395. PRO-2038 owns the separate launch
promotion, with named security sign-off under PRO-2406 and PRO-1872.
Do not copy the whole internal reference into the public tree: Treasury and
Programs remain outside the current partner contract. Public reference pages
must regenerate from the approved public OpenAPI document.

At promotion, move the authored guides into matching `content/docs` paths,
add the `earn` folder to root navigation, link Embedded Yield from the Earn
landing page, and regenerate API, playground, Postman, and AI artifacts. Verify the
publication gate, exact allowed route list, and links on each release channel.
Do not claim provider-order settlement support until its completion integration
exists and is independently verified.

## Verification limits

On 2026-11-06 the guides ran end to end against a local API on the `beta`
channel, a fresh local database, and a Surfpool devnet fork: Quickstart (both
paths), the cURL and TypeScript deposit flows, balances and pagination, Veda
deposits with floors, sponsored deposits, instant withdrawals, and solver
queue requests. Every TypeScript block typechecks under strict mode with
`@solana/kit` 8.6. Blind agents followed only the `.md` output.

Not covered: Kamino withdrawal builds fail on a Surfpool fork (its
`jsonParsed` decodes klend accounts that real RPCs return as base64), solver
fulfillment and cancellation (the fork's clock barely advances, so no request
reached `expiredCancelable`), operator redemptions, provider orders, mainnet
swaps, and the browser wallet signer, which typechecks but did not run.
Audit findings are in
`docs/architecture/earn-docs-audit.md` at the repo root.
