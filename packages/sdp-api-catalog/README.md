# @sdp/api-catalog

What the API, the dashboard's API playground and the docs need to know about the public SDP
API, kept in one place so they never describe or write a call differently. It ships TypeScript
source with no React, so either app, a script or server code can import it.

| Subpath                      | What it holds                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sdp/api-catalog/reference` | The API reference model: every operation of one release channel's public OpenAPI document, with its parameters, request body schema, each response's body schema and example, module, action and the sample call. `apps/sdp-api/src/openapi/reference.ts` builds it (`openapi:generate` writes it beside `openapi.json`) and the docs render their reference from it, parsing it with `apiReferenceSchema`. |
| `@sdp/api-catalog/snippets`  | `buildSnippets`: one call written as cURL, TypeScript and Python. The key is read from `SDP_API_KEY`, never inlined (`auth: "none"` leaves it out for a public route), and a call carries an `Idempotency-Key` only where its route declares the header (`takesIdempotencyKey`), whatever its method.                                                                                                       |

The dashboard playground still reads its own generated catalog; it moves onto this model next
(PRO-2298).

## Scripts

```sh
pnpm --filter @sdp/api-catalog typecheck
pnpm --filter @sdp/api-catalog test
pnpm --filter @sdp/api-catalog lint
```
