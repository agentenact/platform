import { describe, expect, it } from 'bun:test';
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { authOf, createSettlementLookup } from '../src/signer/settlement-lookup.js';
import { TESTNET } from '../src/owner-client/testnet.js';

const P = Networks.TESTNET;
const SAC = TESTNET.usdcSac;
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const channel = Keypair.random().publicKey();
const HASH = (c: string) => c.repeat(64);

/** A signed-shape x402 payment: one contract call whose auth entry names the payer and a nonce, as the buyer's wallet builds it. */
function payment(nonce: string, address = payer): string {
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: new Address(address).toScAddress(), nonce: xdr.Int64.fromString(nonce), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(SAC).toScAddress(), functionName: 'transfer', args: [] }),
      ),
      subInvocations: [],
    }),
  });
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({ contractAddress: new Address(SAC).toScAddress(), functionName: 'transfer', args: [] })),
    auth: [auth],
  });
  return new TransactionBuilder(new Account(channel, '1'), { fee: '100', networkPassphrase: P }).addOperation(op).setTimeout(60).build().toXDR();
}

const row = (tx: string, o: Partial<{ from: string; to: string; amount: string; asset: string }> = {}) => ({ id: tx, at: '', direction: 'in' as const, kind: 'contract_transfer' as const, from: payer, to: payTo, asset: TESTNET.usdc as string, amount: '0.0100000', tx, ...o });
const asked = (nonce: string) => ({ payload: { payload: { transaction: payment(nonce) } }, payer, payTo, units: '100000' });

function lookup(chain: { payments: ReturnType<typeof row>[][]; envelopes: Record<string, string> }) {
  let poll = 0;
  const calls = { payments: 0, slept: 0 };
  let t = 0;
  const find = createSettlementLookup({
    payments: async () => (calls.payments++, { account: payTo, network: 'testnet' as const, truncated: false, payments: chain.payments[Math.min(poll++, chain.payments.length - 1)]! }),
    envelope: async (tx) => {
      const e = chain.envelopes[tx];
      if (!e) throw new Error('horizon 404');
      return e;
    },
    sleep: async (ms) => void ((t += ms), calls.slept++),
    now: () => t,
    waitMs: 9_000,
    everyMs: 3_000,
  });
  return { find, calls };
}

describe('authOf', () => {
  it('reads the payer and nonce of the auth entry, and nothing from anything else', () => {
    expect(authOf(payment('77'), P)).toEqual({ address: payer, nonce: '77' });
    expect(authOf('AAAA', P)).toBeNull();
    const plain = new TransactionBuilder(new Account(channel, '1'), { fee: '100', networkPassphrase: P }).addOperation(Operation.bumpSequence({ bumpTo: '5' })).setTimeout(60).build().toXDR();
    expect(authOf(plain, P)).toBeNull();
  });

  it('reads through the fee bump the facilitator wraps a payment in', () => {
    const inner = TransactionBuilder.fromXDR(payment('78'), P) as ReturnType<typeof TransactionBuilder.fromXDR> & { sign(k: Keypair): void };
    const fee = Keypair.random();
    const bump = TransactionBuilder.buildFeeBumpTransaction(fee, '200', inner as never, P);
    expect(authOf(bump.toXDR(), P)).toEqual({ address: payer, nonce: '78' });
  });
});

describe('the lookup', () => {
  it('finds the transaction that carries this very authorization', async () => {
    const { find } = lookup({ payments: [[row(HASH('a'))]], envelopes: { [HASH('a')]: payment('5') } });
    expect(await find(asked('5'))).toBe(HASH('a'));
  });

  it('never takes the same buyer paying the same amount in another call', async () => {
    const { find, calls } = lookup({ payments: [[row(HASH('a'))]], envelopes: { [HASH('a')]: payment('6') } });
    expect(await find(asked('5'))).toBeNull();
    expect(calls.slept).toBeGreaterThan(0);
  });

  it('keeps looking until the payment shows up', async () => {
    const { find } = lookup({ payments: [[], [row(HASH('b'))]], envelopes: { [HASH('b')]: payment('5') } });
    expect(await find(asked('5'))).toBe(HASH('b'));
  });

  it('ignores another payer, another seller, another amount and another asset before reading any envelope', async () => {
    const other = Keypair.random().publicKey();
    const { find } = lookup({
      payments: [[row(HASH('c'), { from: other }), row(HASH('d'), { to: other }), row(HASH('e'), { amount: '0.0500000' }), row(HASH('f'), { asset: 'XLM' })]],
      envelopes: { [HASH('c')]: payment('5'), [HASH('d')]: payment('5'), [HASH('e')]: payment('5'), [HASH('f')]: payment('5') },
    });
    expect(await find(asked('5'))).toBeNull();
  });

  it('gives up at its deadline, and a read that fails only costs that look', async () => {
    let t = 0;
    let looks = 0;
    const find = createSettlementLookup({
      payments: async () => {
        looks++;
        throw new Error('horizon down');
      },
      envelope: async () => '',
      sleep: async (ms) => void (t += ms),
      now: () => t,
      waitMs: 9_000,
      everyMs: 3_000,
    });
    expect(await find(asked('5'))).toBeNull();
    expect(looks).toBeGreaterThan(1);
    expect(t).toBeLessThanOrEqual(9_000);
  });

  it('a payload it cannot read is not looked up at all', async () => {
    const { find, calls } = lookup({ payments: [[row(HASH('a'))]], envelopes: {} });
    expect(await find({ payload: { payload: { transaction: 'nope' } }, payer, payTo, units: '100000' })).toBeNull();
    expect(await find({ payload: {}, payer, payTo, units: '100000' })).toBeNull();
    expect(calls.payments).toBe(0);
  });

  it('an authorization signed by someone other than the buyer is not looked up', async () => {
    const { find, calls } = lookup({ payments: [[row(HASH('a'))]], envelopes: { [HASH('a')]: payment('5') } });
    expect(await find({ payload: { payload: { transaction: payment('5', Keypair.random().publicKey()) } }, payer, payTo, units: '100000' })).toBeNull();
    expect(calls.payments).toBe(0);
  });
});
