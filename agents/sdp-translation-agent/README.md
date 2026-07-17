# SDP Translation Agent

This is the Eve agent used by the release workflow to translate missing SDP web UI strings.

The agent receives one locale batch through Eve's structured HTTP session API and returns translations. It has no repository access and no write tools. GitHub Actions performs catalog discovery, placeholder and markup validation, file writes, and the release-branch commit.

## Vercel deployment

Create a separate Vercel project rooted at this directory. Configure these Vercel environment variables:

- `TRANSLATION_AGENT_MODEL` - an AI Gateway model id
- `TRANSLATION_AGENT_USERNAME` - HTTP Basic username
- `TRANSLATION_AGENT_PASSWORD` - HTTP Basic password

Link the project to AI Gateway through Vercel OIDC or provide `AI_GATEWAY_API_KEY`. Set the resulting production URL as the repository variable `TRANSLATION_AGENT_URL`, and put the same Basic credentials in the repository secrets `TRANSLATION_AGENT_USERNAME` and `TRANSLATION_AGENT_PASSWORD`.

Local development uses `pnpm install`, `pnpm dev`, and the built-in Eve HTTP channel. Eve requires Node 24.
