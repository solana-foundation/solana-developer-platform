# Earn docs authoring

These files are private source drafts. The site reads only `content/docs`, so
they do not enter search, the sitemap, Markdown routes, Postman, or AI resources.
`module: earn` also preserves the module's publication gate when guides move.

## Review

- `earn/index.mdx`: overview and guide entry point.
- `earn/quickstart.mdx`: direct API and generated Embedded Yield sandbox paths.
- `earn/deposit-api.mdx`: complete sandbox deposit requests in cURL and TypeScript.
- `earn/concepts.mdx`: strategies, shares, value, and withdrawal availability.
- `earn/integration-details.mdx`: exact quotes, sponsorship, swaps, and retries.
- `earn/treasury.mdx`: organization custody wallet flow.
- `guides/embedded-yield.mdx`: backend integration and customer signing.
- `earn/providers.mdx`: availability, eligibility, and flow of funds.
- `earn/withdrawals.mdx`: direct, solver, and operator exits.
- `earn/reporting.mdx`: live holdings, observed settlement, earnings limits.
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

Quickstart accepts `?integration=earn-api` or `?integration=embedded-yield`.
Missing or unsupported values select Earn API. Its expandable HTTP helper stays
fully present in Markdown, search, and AI resources. The page outline follows
the visible path; a heading fragment can still open the other path.

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

The examples were checked against schemas and current implementation. They
have not been run with a funded wallet or live provider credentials. A complete
sandbox deposit and exit, customer wallet signing, sponsor co-signing, and
asynchronous recovery remain release checks. Audit findings and focused test
results are recorded in `docs/architecture/earn-docs-audit.md` at the repo root.
