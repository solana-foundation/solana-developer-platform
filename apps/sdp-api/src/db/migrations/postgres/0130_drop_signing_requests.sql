-- sdp:migration-compat: breaking
-- signing_requests has had no reader or writer since the legacy raw signing
-- stack was retired (#1880). Its own file, not 0129: dropping its foreign keys
-- locks organizations, custody_configs and issuance_transactions, and here that
-- lock lasts only this statement's transaction.
DROP TABLE signing_requests;
