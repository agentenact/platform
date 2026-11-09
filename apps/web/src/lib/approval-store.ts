import type { Approval, ApprovalStore } from '@/lib/signing-flow';

export const APPROVAL_KEY = 'ae.registered';
type Registered = { approval: Approval; txHash?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The register approval the bind depends on, kept in the browser's own storage so it survives a reload between the two
 * taps. It is the only place the gate reads it from: nothing the api says is ever written here. Reads never throw
 * (private mode, a corrupt value): the gate then refuses the bind, which is the safe answer. Writes throw, and the gate
 * does not send the signature when the save failed.
 */
export function browserApprovalStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage): ApprovalStore {
  return {
    getRegistered() {
      try {
        const raw = storage.getItem(APPROVAL_KEY);
        if (!raw) return null;
        const v: unknown = JSON.parse(raw);
        if (!isObj(v) || !isObj(v.approval)) return null;
        const a = v.approval;
        if (typeof a.signedEntryXdr !== 'string' || typeof a.summary !== 'string' || !isObj(a.call) || typeof a.call.fn !== 'string') return null;
        if (v.txHash !== undefined && typeof v.txHash !== 'string') return null;
        return v as unknown as Registered;
      } catch {
        return null;
      }
    },
    setRegistered(v) {
      storage.setItem(APPROVAL_KEY, JSON.stringify(v));
    },
    clearRegistered() {
      storage.removeItem(APPROVAL_KEY);
    },
  };
}
