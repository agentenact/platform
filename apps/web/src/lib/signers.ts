import type { Bundle, StellarSigner } from './verifier-bundle';

export const FRIENDBOT = 'https://friendbot.stellar.org';
const HORIZON = 'https://horizon-testnet.stellar.org';

async function failure(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`;
}

/** True when the account exists on testnet (funded). Any answer other than 200/404 throws with the real cause. */
export async function accountExists(address: string): Promise<boolean> {
  const res = await fetch(`${HORIZON}/accounts/${address}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Horizon testnet: ${await failure(res)}`);
  return true;
}

export async function fundWithFriendbot(address: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`Friendbot: ${await failure(res)}`);
}

/** A Freighter-backed owner. Freighter is imported only here, only when the visitor picks it. */
export async function freighterSigner(bundle: Bundle): Promise<StellarSigner> {
  const freighter = await import('@stellar/freighter-api');
  const connected = await freighter.isConnected();
  if (connected.error || !connected.isConnected) {
    throw new Error(connected.error?.message ?? 'Freighter not found. Install the Freighter extension, or use a temporary wallet.');
  }
  const access = await freighter.requestAccess();
  if (access.error) throw new Error(`Freighter: ${access.error.message}`);
  if (!access.address) throw new Error('Freighter returned no address. Unlock it and approve access, then connect again.');
  const network = await freighter.getNetworkDetails();
  if (network.error) throw new Error(`Freighter: ${network.error.message}`);
  if (network.networkPassphrase !== bundle.Networks.TESTNET) {
    throw new Error(`Switch Freighter to Testnet (it is on ${network.network || 'another network'}), then connect again.`);
  }
  const address = access.address;
  return {
    publicKey: address,
    async signTransaction(xdr, networkPassphrase) {
      const signed = await freighter.signTransaction(xdr, { networkPassphrase, address });
      if (signed.error) throw new Error(`Freighter: ${signed.error.message}`);
      return signed.signedTxXdr;
    },
  };
}

/** A throwaway owner: the key lives in this page's memory only and signs without prompts. */
export function tempSigner(bundle: Bundle): StellarSigner {
  const keypair = bundle.Keypair.random();
  return {
    publicKey: keypair.publicKey(),
    async signTransaction(xdr, networkPassphrase) {
      const tx = bundle.TransactionBuilder.fromXDR(xdr, networkPassphrase);
      tx.sign(keypair);
      return tx.toXDR();
    },
  };
}
