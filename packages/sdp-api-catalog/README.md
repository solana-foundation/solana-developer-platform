# @sdp/api-catalog

The public OpenAPI document produces one reference model for each release channel.
The docs render that model; the dashboard uses a smaller generated projection for
its existing playground sections. All three apps share the same operation IDs,
parameters and examples.

- `@sdp/api-catalog/reference` defines every public operation, including Health
  and Projects, with request schemas and per-status response examples.
- `@sdp/api-catalog/catalog` lists those operations in document order and
  projects the existing dashboard playground forms from them.
- `@sdp/api-catalog/playground-catalog` is generated at `experimental` by
  `pnpm generate:api-playground`. It carries the dashboard's four existing
  sections and proxy allowlist. The dashboard filters them by release channel.
- `@sdp/api-catalog/snippets` writes cURL, TypeScript and Python samples. It
  reads the key from `SDP_API_KEY` and sends `Idempotency-Key` only when the
  route declares it.

The docs build gets its channel-specific reference from
`apps/sdp-api/generated/api-reference.json`. The committed playground projection
stays at `experimental` so CI can check drift across all sections.

## Checks

```sh
pnpm --filter @sdp/api-catalog typecheck
pnpm --filter @sdp/api-catalog test
pnpm --filter @sdp/api-catalog lint
pnpm check:api-playground
```
