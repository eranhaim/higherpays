'use strict';

const express = require('express');

const router = express.Router({ mergeParams: true });

// Kept temporarily so older consoles receive an explicit migration response.
// New access is managed directly on each workspace member.
router.all('*', (_req, res) => res.status(410).json({ error: 'custom_roles_removed' }));

module.exports = router;
