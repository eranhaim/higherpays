'use strict';
// In-memory sliding-window rate limiting. One API instance today, so a
// process-local store is enough; move the store to Postgres or Redis before
// running more than one replica.
const { TooManyRequestsError } = require('./errors');

function createLimiter({ windowMs, max }) {
  const hits = new Map();

  function recent(key, now) {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  }

  return {
    /** Records one hit; returns true when the key is now over the limit. */
    hit(key) {
      const now = Date.now();
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
      return list.length > max;
    },
    isBlocked(key) {
      return recent(key, Date.now()).length >= max;
    },
    reset(key) {
      hits.delete(key);
    },
    /** Express middleware: counts every request for `keyOf(req)`. */
    middleware(keyOf) {
      return (req, _res, next) => {
        if (this.hit(keyOf(req))) {
          return next(new TooManyRequestsError('Too many requests. Try again later.', { retryAfterSeconds: Math.ceil(windowMs / 1000) }));
        }
        next();
      };
    },
  };
}

module.exports = { createLimiter };
