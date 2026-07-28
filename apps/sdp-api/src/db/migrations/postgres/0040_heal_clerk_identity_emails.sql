-- Repairs identity emails left holding an unsubstituted Clerk JWT template placeholder.
--
-- A misconfigured template passed unknown shortcodes through verbatim, so rows were
-- written with the literal `{{user.primary_email_address.email_address}}` where an
-- address belonged. The template itself is fixed; this repairs what it already stored.
--
-- The placeholder is byte-identical for every affected user, so it identifies nobody, and
-- `auth_user_identities.email` is matched literally against `invitations.email` when a
-- Clerk session joins an organisation. An affected user therefore never matches their own
-- pending invitation and is silently denied the role they were invited with.
--
-- Either copy of the email can be the corrupted one depending on which code path wrote
-- the row, so each is repaired from the other and only when the other is a plausible
-- address. Rows where both copies are corrupt are left alone: there is nothing local to
-- recover them from and they need a Clerk lookup.
--
-- Both statements are scoped to `provider = 'clerk'`, matching the reader. A user can hold
-- an identity row per provider, and the second statement joins on `user_id` alone, so
-- without the filter Postgres would be free to pick any of them as the repair source.

UPDATE auth_user_identities AS aui
SET email = u.email,
    updated_at = sdp_datetime_now()
FROM users AS u
WHERE u.id = aui.user_id
  AND aui.provider = 'clerk'
  AND aui.email LIKE '%{{%'
  AND u.email NOT LIKE '%{{%'
  AND u.email LIKE '%@%.%';

-- `users.email` is NOT NULL UNIQUE, so this is skipped where the recovered address is
-- already taken by another row. Colliding rows are left corrupt rather than failing the
-- migration; they are a merge decision, not a repair.
UPDATE users AS u
SET email = aui.email
FROM auth_user_identities AS aui
WHERE aui.user_id = u.id
  AND aui.provider = 'clerk'
  AND u.email LIKE '%{{%'
  AND aui.email NOT LIKE '%{{%'
  AND aui.email LIKE '%@%.%'
  AND NOT EXISTS (
    SELECT 1 FROM users AS other WHERE other.email = aui.email AND other.id <> u.id
  );
