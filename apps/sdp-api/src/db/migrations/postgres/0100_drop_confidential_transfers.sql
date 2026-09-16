DELETE FROM payment_transfer_recipients
 WHERE transfer_id IN (
    SELECT id FROM payment_transfers WHERE type = 'transfer_confidential'
 );

DELETE FROM payment_requests
 WHERE fulfilled_by_transfer_id IN (
    SELECT id FROM payment_transfers WHERE type = 'transfer_confidential'
 );

UPDATE payment_subscription_collection_attempts
   SET transfer_id = NULL
 WHERE transfer_id IN (
    SELECT id FROM payment_transfers WHERE type = 'transfer_confidential'
 );

DELETE FROM payment_transfers
 WHERE type = 'transfer_confidential';
