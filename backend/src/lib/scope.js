'use strict';
// Two tiny helpers used by every workspace-scoped route. Kept here so 15+ route
// files stop redefining them and so a future scoping change (e.g. reading the
// workspace id from the JWT rather than a header) only needs to touch one file.

const wid = (req) => req.access && req.access.workspaceId;
const uid = (req) => req.user && req.user.id;

module.exports = { wid, uid };
