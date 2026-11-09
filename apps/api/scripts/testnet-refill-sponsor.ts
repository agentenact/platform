// Tops up the TESTNET sponsor with friendbot XLM, without its secret: each round friendbot-funds a throwaway account
// (10,000 XLM) and merges it into the sponsor (account_merge sends everything, the base reserve included, and deletes it).
// The throwaway secret lives in memory for one round and is never printed.
//
//   bun run scripts/testnet-refill-sponsor.ts [rounds=1] [sponsor=GAYTGRAY…YPFS]
//
// Testnet only: the passphrase and Horizon are pinned. Friendbot limits how often it pays; a refused round stops the run.
import { Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const SPONSOR_TESTNET = 'GAYTGRAY4MHSZGEROVQKXHBWLI3LAB63MRQIMGPNK23HM6V7R65PYPFS';
const rounds = Math.max(1, Math.min(10, Number(process.argv[2] ?? 1) || 1));
const sponsor = process.argv[3] ?? SPONSOR_TESTNET;
if (!/^G[A-Z2-7]{55}$/.test(sponsor)) throw new Error('sponsor must be a G… address');
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');

const balance = async () => (await horizon.loadAccount(sponsor)).balances.find((b) => b.asset_type === 'native')!.balance;
console.log(`sponsor ${sponsor}: ${await balance()} XLM`);
for (let i = 1; i <= rounds; i++) {
  const kp = Keypair.random();
  const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!r.ok) {
    console.error(`round ${i}: friendbot refused (${r.status}); stopping`);
    break;
  }
  const tx = new TransactionBuilder(await horizon.loadAccount(kp.publicKey()), { fee: '1000', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.accountMerge({ destination: sponsor }))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  const res = await horizon.submitTransaction(tx);
  console.log(`round ${i}: merged ${kp.publicKey()} into the sponsor, tx ${res.hash}`);
}
console.log(`sponsor ${sponsor}: ${await balance()} XLM`);
