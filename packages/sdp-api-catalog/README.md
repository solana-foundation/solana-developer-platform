# @sdp/api-catalog

What the dashboard's API playground and the docs both need to know about the public SDP API,
kept in one place so the two never write a call differently. It ships TypeScript source with no
React, so either app, a script or server code can import it.

| Subpath | What it holds |
| -- | -- |
| `@sdp/api-catalog/snippets` | `buildSnippets`: one call written as cURL, TypeScript and Python. The key is read from `SDP_API_KEY`, never inlined, and every write carries an `Idempotency-Key`. |

The playground's operation catalog, generated from the public OpenAPI document, moves here next
(PRO-2298), so the docs reference can render from the same data.

## Scripts

```sh
pnpm --filter @sdp/api-catalog typecheck
pnpm --filter @sdp/api-catalog test
pnpm --filter @sdp/api-catalog lint
```
