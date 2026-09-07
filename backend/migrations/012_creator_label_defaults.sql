-- Keep new workspaces on the product terminology unless an agency chooses
-- custom labels.

ALTER TABLE workspaces
  ALTER COLUMN account_label SET DEFAULT 'Creator',
  ALTER COLUMN account_label_plural SET DEFAULT 'Creators';

UPDATE workspaces
   SET account_label = 'Creator',
       account_label_plural = 'Creators'
 WHERE account_label = 'Account'
   AND account_label_plural = 'Accounts';
