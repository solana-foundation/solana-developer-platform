# Sentry user feedback

The dashboard initializes Sentry in the browser, server, and edge runtime when
`NEXT_PUBLIC_SENTRY_DSN` is set. Development and
`NEXT_PUBLIC_DISABLE_SENTRY=1` turn it off. Sentry receives request and
rendering errors, sampled traces and replays, and feedback submitted through
its widget. These SDK signals are separate from the Grafana log inventory.

## Feedback entry points

- **Send feedback** in the sidebar user menu opens the feedback screen
  (`/dashboard/{projectId}/feedback`). It asks what the feedback is about
  (something's broken, an idea, a question), what the user would change, and
  optional screenshots or PDFs (10 MB in all). It sends them with
  `Sentry.sendFeedback`, tagged `feedback_category`, with the session's replay
  and the attachments. Without a Sentry client the screen says feedback cannot
  be sent rather than dropping it.
- The global error page captures the exception and opens Sentry's report
  dialog with that event ID when the user selects **Report this issue**.

The client does not register Sentry's feedback widget; the screen is the only
feedback form.

## Identity and privacy

`SentryUserContext` sends the Clerk user ID and an organization ID tag. It does
not attach the user's name or email. The feedback screen asks for no name or email. `sendDefaultPii` is false, and shared Sentry hooks scrub event content.
Replay masks text and blocks media. A user can still choose to attach a
screenshot or enter identifying text in feedback, so review the submitted
content when handling an issue.

## External routing

The repository does not configure Sentry alerts or its Linear integration.
Before relying on automatic issue creation, verify the `sdp-web` Sentry project,
the feedback issue alert, its Linear destination, and a test submission in the
target environment. A configured DSN alone does not prove that routing works.

## Troubleshooting

| Symptom                            | Check                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| Feedback screen says it can't send | Confirm the DSN is set and Sentry is enabled for the deployment.                   |
| No Sentry issue appears            | Check the browser request and Sentry project ingestion for the target environment. |
| No Linear issue appears            | Check the Sentry feedback alert and Linear integration, then submit a test report. |
| Replay is absent                   | Production session replay is sampled at 10%; an error can trigger replay at 100%.  |
