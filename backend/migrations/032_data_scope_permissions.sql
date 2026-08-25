-- ============================================================================
-- Migration 032: permission vocabulary for scoped visibility
--
-- Roles are per-workspace DATA (roles.permissions jsonb), and middleware/index.js
-- prefers that jsonb over the built-in matrix. So changing the vocabulary in
-- code without rewriting the stored arrays would silently change behaviour for
-- every existing workspace. This migration is that rewrite.
--
--   removed  sales.view       gated nothing; there is no sales entity
--   removed  settings.danger  gated nothing; the owner/admin boundary is
--                             roleWithinCallerRights refusing to grant `owner`,
--                             plus the last-owner guard — not a permission
--   added    fees.view        HigherPays' margin + itemised per-transaction
--                             fees; owner/admin only
--   added    data.view_all    scope modifier: see the whole workspace rather
--                             than only your own rows. Without it a membership
--                             is narrowed by resolveDataScope — an agent to the
--                             accounts it is assigned, an account to itself.
--   added    links.view       for `account`, whose view includes its own
--                             issued payment links
--
-- REMOVALS apply to every role row, custom ones included. roles.routes.js
-- cleanPerms() filters writes against the catalog, so a string that has left the
-- catalog can never be saved again — and roleWithinCallerRights compares a
-- role's stored array against the caller's held set, so a custom role still
-- carrying a dropped string yields a permanently non-empty `unheld`. That role
-- would become impossible to assign to anyone, 403, with nothing to explain it.
--
-- ADDITIONS apply to system roles ONLY. A custom role is a deliberate statement
-- of what someone should see; silently granting it data.view_all would hand an
-- agency's agents the whole workspace — the exact bug this work removes. Owners
-- opt in through the role editor.
-- ============================================================================

BEGIN;

-- 1) Removals — every role row, system and custom.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
       FROM jsonb_array_elements_text(permissions) p
      WHERE p NOT IN ('sales.view', 'settings.danger'))
 WHERE permissions ?| array['sales.view', 'settings.danger'];

-- 2) Additions — system roles only, idempotent.
UPDATE roles SET permissions = permissions || '["fees.view"]'::jsonb
 WHERE is_system AND name IN ('owner', 'admin') AND NOT permissions ? 'fees.view';

UPDATE roles SET permissions = permissions || '["data.view_all"]'::jsonb
 WHERE is_system AND name IN ('owner', 'admin', 'analyst') AND NOT permissions ? 'data.view_all';

UPDATE roles SET permissions = permissions || '["links.view"]'::jsonb
 WHERE is_system AND name = 'account' AND NOT permissions ? 'links.view';

-- admin needs no separate step: settings.danger was the only permission owner
-- held and admin did not, so removing it above already makes the two identical.

COMMIT;
