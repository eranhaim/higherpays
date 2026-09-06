-- The product calls account records creators. Preserve agencies that chose a
-- custom vocabulary, but update the old platform default.
UPDATE workspaces
   SET account_label = 'Creator',
       account_label_plural = 'Creators'
 WHERE account_label = 'Account'
   AND account_label_plural = 'Accounts';
