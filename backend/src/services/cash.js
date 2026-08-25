'use strict';
// Can the agency pay everyone today?
//
// `received` is what actually reached the agency in the period (gross minus
// every fee), `held` is the part of that the provider keeps in the rolling
// reserve, `owed` is what creators and chatters are still due. The shortfall
// is the cash the agency must front if it pays in full now.

const round2 = (v) => Math.round(v * 100) / 100;

function cashPosition({ owed, received, held }) {
  const available = round2(received - held);
  return {
    owed: round2(owed),
    received: round2(received),
    heldInReserve: round2(held),
    available,
    shortfallIfPaidNow: round2(Math.max(0, owed - available)),
  };
}

module.exports = { cashPosition };
