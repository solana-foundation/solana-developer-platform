# Email

> **Maintainers only.**

SDP sends email through Iterable, the Foundation's sender for its email domains. Today that covers the mainnet access request email to SDP operators (HOO-2427) and admin alerts (HOO-2299).

## How it works

- **The content lives in code.** `apps/sdp-api/src/services/email-layout.ts` turns structured content into an HTML card and a plain-text part: a heading, a one-line summary, label and value details, at most one button and a note. It escapes every field. Write a new email as `EmailContent` (see `mainnetAccessRequestEmailContent`) and send it with `sendIterableEmail`. Don't write HTML.
- **Iterable only delivers.** Each environment has one triggered campaign on the Transactional Channel whose template renders our fields as they are:

  | Template field | Value                                                         |
  | -------------- | ------------------------------------------------------------- |
  | Subject        | `{{subject}}`                                                 |
  | HTML version   | `{{{bodyHtml}}}` (nothing else)                               |
  | Plain text     | `{{{body}}}` (custom plain text on)                           |
  | Reply-to       | `{{#if replyTo}}{{replyTo}}{{else}}noreply@solana.org{{/if}}` |
  | Message type   | Transactional Message                                         |

  Never put an SDP email on a marketing message type. A marketing unsubscribe would silently drop it, and Gmail files those under Promotions.
- **Off unless configured.** `iterableEmailConfig` reads `ITERABLE_API_URL`, `ITERABLE_API_KEY` and `ITERABLE_TRANSACTIONAL_CAMPAIGN_ID`. If any is missing or a placeholder, nothing is sent, mainnet access requests answer 503, and alerts are skipped without retrying.
- **No idempotency key.** Iterable has none, so a caller that must not send twice keeps its own record of what it sent. Admin alerts keep one per recipient.

## Configuration

| Key                                  | Prod (Doppler `prd`, mounted by sdp-infra) | Local development (Doppler `dev`)                | CI (Doppler `dev_ci`) |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------------ | --------------------- |
| `ITERABLE_API_URL`                   | `https://api.iterable.com` (Terraform)     | `https://api.iterable.com`                       | inherited             |
| `ITERABLE_API_KEY`                   | prod key                                   | dev key                                          | empty: CI never sends |
| `ITERABLE_TRANSACTIONAL_CAMPAIGN_ID` | prod campaign                              | dev campaign ("SDP Dev" sender)                  | inherited             |
| `SDP_OPERATOR_EMAIL`                 | the operator alias                         | unset; set your own in `apps/sdp-api/.env.local` | unset                 |

Stage has no Iterable key, so it sends nothing.

## Get SDP email locally

1. Run the API with Doppler as usual (`pnpm dev:api`). `dev` already holds the dev key and campaign.
2. To receive mainnet access request emails, add your own address to `apps/sdp-api/.env.local`:

   ```bash
   SDP_OPERATOR_EMAIL=you@solana.org
   ```

3. Admin alerts go to the org admins in your local database, so sign in with your own address. Their dashboard link uses `FRONTEND_URL`. The layout allows `http` only for localhost, so `http://localhost:3000` works.

Dev emails come from "SDP Dev" and only reach real inboxes you put in front of them. Use your own address, not a customer's.

## When an email doesn't arrive

Iterable accepts a send before trying to deliver it, so a `Success` answer doesn't mean the email arrived. Read the recipient's events, with the key injected by Doppler so it never prints:

```bash
doppler run --config dev -- sh -c 'curl -sS "https://api.iterable.com/api/events/you@solana.org?limit=10" -H "Api-Key: $ITERABLE_API_KEY"'
```

| Event                                      | Meaning                                                                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emailSend`                                | Delivered to the recipient's mail server. Check spam, and search Gmail with `in:anywhere`.                                                                                                                 |
| `emailSendSkip` with `MessageServiceError` | Iterable couldn't hand it to its mail service. Check that the campaign's channel has a sending platform (Iterable: Settings, Email subscription channels). The Transactional Channel had none until 10/30. |
| `emailSendSkip` with another reason        | The recipient is unsubscribed or suppressed, or the message type blocks them.                                                                                                                              |
| `emailBounce`                              | The recipient's server refused it.                                                                                                                                                                         |
