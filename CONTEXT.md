# Solana Developer Platform

Solana Developer Platform gives organizations project-scoped access to tokenization, custody, payments, RPC, and compliance capabilities.

## Language

**Organization**:
The team workspace through which every SDP user accesses projects and product capabilities. SDP does not model a separate individual-user product tier.
_Avoid_: Individual account, enterprise customer, personal workspace

**Generally Available Provider**:
A **Provider** that any **Organization** may use when it is configured in the current deployment environment.
_Avoid_: Individual-tier provider, free-tier provider, default entitlement

**Manual Provider Activation**:
An organization-specific approval that makes a manually onboarded **Provider** available after the organization contacts SDP and completes the required commercial or operational onboarding.
_Avoid_: Enterprise tier, vetted user, provider override

**Provider Availability**:
Whether an **Organization** can use a **Provider** in a **Provider Family** in the current deployment environment. A provider must be configured and must either be **Generally Available** or have a **Manual Provider Activation** for that organization.
_Avoid_: Customer tier, runtime health, selected provider, project setup

**Private Transfer**:
A **Payment Transfer** whose transaction is built by a private-transfer **Provider** and executed through provider-specific routing metadata before final settlement.
_Avoid_: Confidential transfer, shielded transfer

**Private Channels Integration**:
A **Privacy Integration** that connects an SDP project to Solana Private Channels and enables private capabilities within existing SDP product flows.
_Avoid_: Private Channels product, Private Channels workspace, standalone Payments module

**Privacy Integration**:
A provider integration that adds private execution or settlement capabilities to existing SDP product flows.
_Avoid_: Privacy product, private workspace, private payment rail

**Private Channel Instance**:
The external Private Channels environment connected to an SDP project for its private operations.
_Avoid_: Private channel, SDP project, provider account

**Private Channels Principal**:
A project-scoped financial or operational participant used to authenticate with a **Private Channel Instance**. A project has one default principal and may add named principals for real legal, fund, customer, or operational boundaries. A principal is not an SDP user or API key.
_Avoid_: Invited user, employee account, SDP actor, member invitation

**Enrolled Private Channel Wallet**:
An SDP custody wallet that has proved control to a **Private Channel Instance** and is bound to one **Private Channels Principal** for that instance.
_Avoid_: Invited wallet, user identity, external wallet

**Counterparty Account**:
A payment destination or payout instrument owned by a **Counterparty**. A Solana crypto-wallet **Counterparty Account** stores the recipient wallet owner address; token accounts are derived during payment execution.
_Avoid_: Custody wallet, token account, provider account data

**Recurring Payment**:
A payments product flow that repeatedly sends a fixed SPL token amount from an SDP custody source wallet to a **Counterparty Account** on a configured period. Initial records are created as pending activation; execution endpoints add the on-chain lifecycle.
_Avoid_: Low-level subscription record, billing plan template, native SOL transfer

**Action**:
One thing a route does, named `module.verb` (for example `transfers.execute`). Every route declares exactly one. The verbs are `read`, `manage` (reversible SDP changes), `execute` (irreversible or leaves SDP: money, chain, providers, or where money goes), `configure` (provider and credential setup), plus issuance's `enforce` and `authority`.
_Avoid_: permission, scope, role, operation family

**Grant**:
An action an API key holds. A key holds an explicit list of grants, never a role or a wildcard; a module's `manage` or `execute` also covers its `read`. A key can never hold key, member, organization or project administration, or any `configure`.
_Avoid_: API key role, permission, Allowed Operations, API key policy

**Payment Request**:
A payments v2 product flow that asks a payer to complete a payment through a Solana Pay payload or a hosted payment link.
_Avoid_: Payment Transfer, generic email

**Managed Reconciliation Cadence**:
The deployment-owned frequency for one pass over SDP's managed background reconcilers. It is distinct from each reconciler's self-hosted cadence and from monitoring tolerance windows.
_Avoid_: Hard-coded job interval, Sentry schedule, self-hosted cron cadence

## Relationships

- An **Organization** has **Provider Availability** for each **Provider** in each **Provider Family**.
- Every SDP user operates through an **Organization**; organization membership is not an access tier.
- A **Generally Available Provider** does not require organization-specific approval.
- A manually onboarded **Provider** requires a **Manual Provider Activation** for each **Organization** that uses it.
- **Provider Availability** is distinct from provider runtime health.
- **Provider Availability** is distinct from whether a **Project** has selected or initialized a **Provider**.
- A **Private Transfer** is still a **Payment Transfer**; privacy changes how the transfer is prepared and submitted, not the wallet permission model.
- A **Private Channels Integration** contributes private capabilities to existing SDP product flows instead of creating a separate product surface.
- A **Private Channels Integration** belongs to the **Privacy Integration** provider family.
- A **Private Channels Integration** connects an SDP project to a **Private Channel Instance**.
- A **Private Channels Integration** has one default **Private Channels Principal** and may have additional named principals.
- An **Enrolled Private Channel Wallet** belongs to exactly one **Private Channels Principal** for a connected instance.
- SDP users and API keys authorize and initiate operations; they are not **Private Channels Principals**.
- SPC cannot delete principals. Legacy per-user SPC identities may remain orphaned upstream; SDP stops using them and does not create new per-user credentials.
- A **Counterparty** may have one or more **Counterparty Accounts**.
- A **Recurring Payment** pays a **Counterparty Account** from an SDP custody source wallet.
- A route answers a caller only if the caller holds the route's **Action**: an API key through its **Grants**, a signed-in member through their organization role.
- **Grants** belong to one API key and apply to every custody wallet that key can access; they refuse a request or let it run, and never pause it.
- An **Action** added to SDP later is granted to no existing key.
- A **Payment Request** may be delivered by email, but the email is not the **Payment Request**.
- Every managed reconciler in one managed run follows the **Managed Reconciliation Cadence**, while its self-hosted equivalent may run at a different cadence.

## Example Dialogue

> **Dev:** "MoonPay is configured in the environment, so is it available for every organization?"
> **Domain expert:** "Only if MoonPay is generally available. A manually onboarded provider also needs an activation for that organization."

> **Dev:** "Should we make this organization enterprise so it can use Fireblocks?"
> **Domain expert:** "No. Activate Fireblocks for that organization; provider access is independent of customer tiers."

> **Dev:** "This key has `transfers.execute`. Can it request an off-ramp quote?"
> **Domain expert:** "No. The quote route declares `offramp.execute`, so the key needs that grant too. Each route names one action, and the key either holds it or is refused."

> **Dev:** "Should the API hard-code the production interval into its Sentry monitors?"
> **Domain expert:** "No. Monitoring must consume the deployment-owned Managed Reconciliation Cadence so its expectation cannot drift from execution."

## Flagged Ambiguities

- "Available" can mean access policy, environment configuration, runtime health, or project setup; resolved: **Provider Availability** means deployment configuration plus general availability or a **Manual Provider Activation**.
- "Team", "organization", and "enterprise" were previously mixed with provider access; resolved: every user operates through an **Organization**, and manually onboarded providers are activated independently of organization type.
- "Payment request" can mean a low-level request payload or a payer-facing payments product; resolved: use **Payment Request** only for the payments v2 payer-facing flow.
- "Reconciliation cadence" previously meant either the deployment's execution schedule or Sentry's expected schedule; resolved: the **Managed Reconciliation Cadence** is deployment-owned, and managed monitoring derives from it.
- "Policy" for custody controls used to mean wallet policies, API key policies, evaluations and approvals; resolved: those concepts no longer exist (ADR 0006). The only per-key control is the key's **Grants** (HOO-2099), which replaced Allowed Operations and roles. Provider-native policy and approval flows are configured in the custody provider, not in SDP.
