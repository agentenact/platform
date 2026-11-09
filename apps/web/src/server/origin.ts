import { PUBLIC } from '@/lib/public-config';

/**
 * This deployment's own origin: APP_ORIGIN from servel.yaml (staging sets https://staging.agentenact.io), else the
 * canonical one. Server-side only; in the browser the page's own location.origin is the same value.
 */
export const appOrigin = (): string => process.env.APP_ORIGIN || PUBLIC.appOrigin;
