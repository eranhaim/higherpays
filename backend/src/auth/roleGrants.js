'use strict';

// Who may hand out which role. Shared by the two paths that can put a role on a
// person: changing an existing member's role, and inviting a new one. Both must
// apply the same rule or the weaker path becomes the way to escalate.

/**
 * A caller may only grant a role whose permissions they hold themselves, so an
 * admin cannot make anyone (including themselves) an owner.
 *
 * Returns {} when the grant is allowed, or { err, detail } when it is not.
 */
async function roleWithinCallerRights(client, req, roleName) {
  const role = (await client.query(
    'SELECT permissions FROM roles WHERE workspace_id=$1 AND name=$2',
    [req.membership.workspaceId, roleName])).rows[0];
  if (!role) return { err: 'unknown_role' };

  const held = req.membership.permissions;
  const unheld = role.permissions.filter((p) => !(held ? held.has(p) : false));
  if (unheld.length) return { err: 'cannot_grant_unheld_permission', detail: unheld.join(',') };

  // owner and admin hold identical permission sets, so the subset check above
  // cannot separate them. This line is the whole owner/admin boundary — remove
  // it and every admin can mint an owner.
  if (roleName === 'owner' && req.membership.role !== 'owner') {
    return { err: 'cannot_grant_unheld_permission', detail: 'owner' };
  }
  return {};
}

module.exports = { roleWithinCallerRights };
