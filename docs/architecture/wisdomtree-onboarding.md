# WisdomTree Earn customer onboarding

Earn uses WisdomTree Connect **Moderator credentials**, separately for sandbox
and production. An SDP customer is an existing project-scoped **counterparty**.
Business KYB records map that counterparty to the returned Connect child
organization GUID. Individual KYC records map to a person GUID. A retail
person's `organization_guid` identifies its moderator; it is never a child
mapping and does not enable the business-wallet deposit rail.

This change adds backend onboarding, not a dashboard form. Earn remains held
out of public OpenAPI/docs and WisdomTree remains unsurfaced. Existing launch,
mainnet-deposit and settlement-tracking requirements still apply. The global
catalogue remains a separate credential-scoped workflow; this change does not
claim a production Moderator trading launch.

## Configure

- Set `WISDOMTREE_SANDBOX_API_KEY` / `WISDOMTREE_API_KEY` to the existing packed
  JSON `{ "clientId", "clientSecret", "username", "password" }` for one
  Moderator API user. Credentials and applicant assignments are environment-specific.
- For document references set `EARN_ONBOARDING_KMS_KEY_NAME` on managed GCP
  deployments. Local/self-hosted testing can use a separate 32-byte base64
  `EARN_ONBOARDING_ENCRYPTION_KEY`, like the SPC credential cipher. Never reuse
  custody or SPC key material. The KMS transport uses the existing transport keys.
- Run migrations 0207 and 0208 before deploying the writer. They add tables,
  composite parent FKs and forced RLS; the previous API revision is compatible.
- Use a sandbox project and sandbox provider credentials for laptop testing.
  Connect onboarding sandbox works independently of Solana; it does not make
  WisdomTree's mainnet-only funds depositable on devnet.

## API flow

All paths below follow `/v1/earn/onboarding/wisdomtree`. Each request requires
an SDP API key or project-selected dashboard session. Reads take `earn.read`;
writes take `earn.execute` and a required `Idempotency-Key`. The project sets
the environment; callers cannot supply provider GUIDs or change parentage.
Responses use `Cache-Control: no-store`.

| Method and path                                 | Behavior                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /forms/{entityType}`                       | Current `business` or `individual` form, including `can_create`, template, choices, CDD conditions and agreements.                                                                                                                                                                                                                                                          |
| `POST /{counterpartyId}`                        | `{ application, documents? }`: create KYC, or save/submit the same business application.                                                                                                                                                                                                                                                                                    |
| `GET /{counterpartyId}`                         | Live provider status and business correction requests; `claimed` means operator reconciliation is required.                                                                                                                                                                                                                                                                 |
| `POST /{counterpartyId}/documents`              | `{ documentType, filename, contentType, contentBase64 }`; one PDF/JPEG/PNG, up to 20 MiB decoded; returns `{ documentId }`.                                                                                                                                                                                                                                                 |
| `POST /{counterpartyId}/corrections/{reasonId}` | Answer one reason with `values`, `explanation`, `attested`, or a customer-scoped `documentId`. Answering does not resubmit.                                                                                                                                                                                                                                                 |
| `POST /{counterpartyId}/wallets`                | `{ owner, signature? }`: register a Solana wallet only after business status is `active` and the moderator still has the child assignment. Proof of control of `owner` is required before anything is claimed: a base58 Ed25519 `signature` over the scope-bound registration message, or `owner`'s authorized binding as an active SDP custody wallet of the same project. |

Start from the current form's `submission_template`, use its choices exactly,
and collect each applicant's actual agreement answers. Never infer agreement
acceptance or choose a CDD tier to avoid collecting people. KYC is US-only,
requires a nine-digit SSN and has no draft. Business tax IDs and CDD sections
follow the form; SDP does not impose US SSN rules on foreign businesses.

For a business, set `application.entity_type` to `organization` and explicitly
set `application.status` to `draft` or `submit`. Upload files separately and
map their returned SDP IDs under `documents`, for example
`{ "formation_document": "earn_document_…", "authorized_rep-valid_id": "earn_document_…" }`.
SDP resolves each ID only within that exact organization/project/environment/
counterparty and supplies the full `{ blob_path, original_filename }` upload
object to WisdomTree. `documentType` can differ from the application slot:
`valid_id` uploads under `authorized_rep-valid_id`.

After corrections, POST the business application with `status: submit` to the
same SDP path before `correctionDueAt`. SDP injects the existing `org_guid`.
Do not send masked/blank GET readback as a new application: it is display data,
with numeric document references and redacted personal data. `submitted` and
unfamiliar statuses never imply approval. Status webhooks are not available;
poll conservatively. Only `active` businesses can register customer wallets.
Wallet registration additionally requires a proof of control. An external
wallet signs the deterministic scope-bound registration message (one line per
organization, project, environment, counterparty and owner address) with its
Ed25519 key and posts the base58 `signature`. An SDP-managed custody wallet
cannot sign arbitrary messages — its keys never leave SDP and no
arbitrary-message signing endpoint exists — so an active custody wallet bound
to the same organization and project is accepted instead: SDP generated and
holds that key, and only a project-authorized caller reaches this route. A
custody binding of another project or organization proves nothing. Because the
address is globally unique per environment and moderator additions are
accepted immediately, an unproven registration of someone else's address would
block its real owner — so the proof is verified before any claim row is
written or any provider call is made.

## Durable state and recovery

A unique database insert claims each customer before a provider create. A
concurrent loser cannot create a second applicant. Returned GUIDs are
first-write-wins and globally unique per environment. Even a failed 4xx can
have saved a business: the client preserves validated recovery GUIDs and the
service links one before returning the error. A later attempt continues that
same GUID. Unfinished claims are never automatically released.

If a request times out, crashes, returns malformed data or fails without a
GUID, the outcome is unknown. Further creates for that customer return 409.
A named operator must use the audited operator-access path, verify the exact
customer against Connect's list/detail and the creating Moderator, then attach
the proven saved GUID with the repository's compare-and-set `link`. Never
match on name alone, delete a claim, guess a GUID, or create another business
just to inspect progress. If no unique applicant can be proven, involve
WisdomTree support. Wallet claims differ in one way: the owner address is
unique per environment across every customer, so a confirmed provider
rejection (any 4xx) archives the unverified claim instead of keeping it —
otherwise a refused registration would permanently block the real owner.
Archived claims are soft-deleted rows, never deleted history. An uncertain
outcome (timeout, 5xx, malformed reply — the wallet may be registered)
keeps the claim like a customer create: reconcile before another write.
Verify the exact stored child's wallet registry before calling
`linkWallet`. Requests naming a
new HTTP key cannot bypass these domain claims.

SSNs, CDD answers, document bytes and provider readback are never stored.
Only immutable identity references, claim state, and encrypted upload-reference
objects are persisted. Idempotent responses contain SDP IDs/state only. Error
bodies may echo personal data, so only validated recovery GUIDs and HTTP status
escape into errors. Uploaded references are encrypted with AAD binding the
organization, project, environment and counterparty; filenames stay encrypted.

## Deposit boundary and request budget

Both custody and external-wallet deposits require a linked owner/customer
mapping before provider eligibility. Then each check makes three Connect reads:
`/organizations/me` (live moderator/assignment), the child's wallet registry,
and products with `organization_guid=<child>`. The latter two run concurrently.
Previously a warm direct-org check made two reads after its cached `/me`;
Moderator checks deliberately add one live assignment read. A cold check also
needs one OAuth grant. Missing mappings make zero Connect requests. The KYC/KYB
change adds **zero Solana RPC requests**; chain reads/builds are unchanged.
Withdrawals do not consult onboarding or these money-in gates.

## Evidence and remaining live validation

Provider wire behavior is covered with offline fixtures, and migration,
concurrency, RLS, HTTP auth/idempotency and encrypted-reference tests run
against disposable local Postgres/Redis. No real applicant or production
provider call is used. A credentialed sandbox run must still measure the actual
Moderator tenant, current forms, create/upload/correction responses and child
assignment lifecycle. The provider documents drafts/corrections as contract
behavior, not a fully measured verification outcome.

Sources checked 2026-10-30: [Postman walkthrough](https://docs.wisdomtreeconnect.com/connect/onboarding/postman),
[onboarding API contract](https://docs.wisdomtreeconnect.com/openapi/connect.openapi.json),
[business walkthrough](https://docs.wisdomtreeconnect.com/guides/onboarding-business.md),
and [Moderator identity guide](https://docs.wisdomtreeconnect.com/guides/moderator-org.md).
Production calls use `api.wisdomtreeconnect.com`; the old `app` API host's
published compatibility period ends October 30, 2026.
