-- sdp:migration-compat: breaking
-- Authentication is Clerk-only; nothing reads or writes these objects.
-- sessions and users.login_count / users.last_login_at belonged to the legacy
-- cookie session and login tracking, removed in #2183, which kept the schema
-- for a dedicated drop. magic_links (passwordless email-login tokens) has had
-- no reader or writer since the initial open-source snapshot. No foreign key
-- references either table; their RLS policies (0081) go with them.
DROP TABLE sessions;

DROP TABLE magic_links;

ALTER TABLE users
    DROP COLUMN login_count,
    DROP COLUMN last_login_at;
