DELETE FROM workflow_executions WHERE action_type = 'notify';
DELETE FROM asset_workflows WHERE action_type = 'notify';
DROP TABLE IF EXISTS notifications;
