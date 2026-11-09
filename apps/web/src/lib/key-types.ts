/** One access key as the api lists it (api /api/tokens). The key itself is never part of this shape. */
export interface TokenView {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}
