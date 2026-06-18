# Solana Developer Platform

Solana Developer Platform gives organizations project-scoped access to tokenization, custody, payments, RPC, and compliance capabilities.

## Language

**Provider Availability**:
Whether an **Organization** can use a **Provider** in a **Provider Family** in the current deployment environment.
_Avoid_: Runtime health, selected provider, project setup

**Private Transfer**:
A **Payment Transfer** whose transaction is built by a private-transfer **Provider** and executed through provider-specific routing metadata before final settlement.
_Avoid_: Confidential transfer, shielded transfer

**Counterparty Account**:
A payment destination or payout instrument owned by a **Counterparty**. A Solana crypto-wallet **Counterparty Account** stores the recipient wallet owner address; token accounts are derived during payment execution.
_Avoid_: Custody wallet, token account, provider account data

**Recurring Payment**:
A payments product flow that repeatedly sends a fixed SPL token amount from an SDP custody source wallet to a **Counterparty Account** on a configured period. Initial records are created as pending activation; execution endpoints add the on-chain lifecycle.
_Avoid_: Low-level subscription record, billing plan template, native SOL transfer

**Wallet Operation**:
A requested action against an SDP custody source wallet, such as a transfer, payment, ramp, issuance administration, raw signing, program invocation, or provider administration.
_Avoid_: Provider request, transaction, payment transfer

**Wallet Operation Envelope**:
The normalized description of a **Wallet Operation** used as policy input before provider execution.
_Avoid_: Provider payload, transaction request, payment request

**Wallet Policy**:
A source-wallet control that determines whether **Wallet Operations** are allowed, denied, or require approval regardless of the initiating actor.
_Avoid_: API key policy, provider policy, payment policy

**API Key Policy**:
A caller-specific control that narrows or routes what an API key may do with the custody wallets it can access.
_Avoid_: Wallet policy, endpoint permission, API key role

**Policy-Scoped Wallet Binding**:
An assignment of an API key to a custody wallet with an explicit policy scope for that wallet.
_Avoid_: Selected wallet, wallet permission, signing wallet

**Policy Evaluation**:
An immutable decision record for a **Wallet Operation** evaluated against the active wallet and API key policies.
_Avoid_: Audit log, provider result, transaction status

**Approval Request**:
An SDP record that pauses a **Wallet Operation** until a configured approver or provider-native approval flow resolves it.
_Avoid_: Provider approval, manual review, multisig

**Provider Control Mapping**:
The translation between SDP policy concepts and provider-native controls when a provider can express them.
_Avoid_: Provider availability, provider policy, custody configuration

**Payment Request**:
A payments v2 product flow that asks a payer to complete a payment through a Solana Pay payload or a hosted payment link.
_Avoid_: Wallet Operation Envelope, Payment Transfer, generic email

**Transactional Email**:
An SDP-owned outbound message for a product workflow.
_Avoid_: Raw email, Clerk organization invitation, generic notification

## Relationships

- An **Organization** has **Provider Availability** for each **Provider** in each **Provider Family**.
- **Provider Availability** is distinct from provider runtime health.
- **Provider Availability** is distinct from whether a **Project** has selected or initialized a **Provider**.
- A **Private Transfer** is still a **Payment Transfer**; privacy changes how the transfer is prepared and submitted, not the wallet permission model.
- A **Counterparty** may have one or more **Counterparty Accounts**.
- A **Recurring Payment** pays a **Counterparty Account** from an SDP custody source wallet.
- A **Wallet Operation Envelope** describes exactly one **Wallet Operation**.
- A **Wallet Policy** is evaluated before an **API Key Policy**.
- An **API Key Policy** can narrow or require approval, but must not silently expand past the **Wallet Policy**.
- A **Policy-Scoped Wallet Binding** connects one API key to one custody wallet.
- A **Policy Evaluation** may create an **Approval Request**.
- A **Provider Control Mapping** can make provider-native controls match an SDP policy revision, partially match it, or remain inapplicable.
- A **Payment Request** may be delivered by email, but the email is not the **Payment Request**.
- A **Transactional Email** may deliver a **Payment Request**, but does not own payment lifecycle or settlement matching.

## Example Dialogue

> **Dev:** "MoonPay is configured in the environment, so is it available for every organization?"
> **Domain expert:** "No. A provider is available only when the organization is entitled to it and the deployment environment is configured for it."

> **Dev:** "Can this API key policy let the key transfer from a wallet whose wallet policy denies transfers?"
> **Domain expert:** "No. The wallet policy is the baseline; the API key policy can only narrow access or route the operation into approval."

## Flagged Ambiguities

- "Available" can mean entitlement, environment configuration, runtime health, or project setup; resolved: **Provider Availability** means entitlement plus deployment configuration only.
- "Policy" can mean **Wallet Policy**, **API Key Policy**, provider-native policy, or payment policy; resolved: use the specific term instead of the generic word when discussing custody controls.
- "Wallet" in policy discussions means an SDP custody source wallet, not a **Counterparty Account** or token account.
- "Approval" can mean an SDP **Approval Request** or a provider-native approval flow; resolved: SDP creates the **Approval Request**, while provider-native approval is reached through **Provider Control Mapping**.
- "Payment request" can mean a low-level request payload or a payer-facing payments product; resolved: use **Payment Request** only for the payments v2 payer-facing flow.
- "Email" can mean Clerk-owned organization invitation delivery or SDP-owned **Transactional Email**; resolved: only **Transactional Email** is owned by SDP.
