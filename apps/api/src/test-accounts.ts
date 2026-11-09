/**
 * Owner emails of the e2e suite, matched on the lower-cased FULL address (the operator domain is part of it: anyone can sign
 * up as kerem+e2e-x@elsewhere). One pattern for the operator list filter, the bulk pause and the public community counts.
 */
export const TEST_EMAIL_REGEX = '^kerem\\+e2e-[a-z0-9._-]+@noras\\.tech$';
/** The operator's own agents for hire (apps/web/scripts/house-agents). Real and running, so the bulk test pause never touches them. */
export const HOUSE_EMAIL_REGEX = '^kerem\\+house(-[a-z0-9._-]+)?@noras\\.tech$';
/**
 * Who the public community counts leave out: only the automated e2e accounts. The operator's own agents (house, manual and
 * kerem@noras.tech) can be hired and used like anyone's, so their activity counts (Kerem, 2026-11-04).
 */
export const NOT_COMMUNITY_EMAIL_REGEX = TEST_EMAIL_REGEX;
