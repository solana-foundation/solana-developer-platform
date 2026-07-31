## UI localization ownership

- For ordinary product pull requests, require new or changed UI copy only in the English source catalogs under `apps/sdp-web/messages/en.json` and `apps/sdp-web/messages/en/**`.
- Do not ask authors to add or update French or other localized catalogs alongside English source changes. The release workflow finds missing locale keys and Eve adds them to `codex/release-main`.
- Do not report temporary English/localized catalog key drift on a product pull request as a defect.
- Review non-English catalog copy when the pull request is explicitly a dedicated translation-quality change, changes the translation automation, or is the automated release pull request.
- When reviewing French copy, follow `.github/translation-guidance.json`; in particular, do not recommend literal terms such as `jeton` for `Token` or `portefeuille` for `Wallet`.
