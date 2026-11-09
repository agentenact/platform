// Generates and friendbot-funds a fresh TESTNET sponsor. The secret goes to stdout ONLY, so it can be
// piped straight into `servel secrets set agentenact-api SPONSOR_SECRET -`; the public key goes to
// stderr. Never redirect stdout to a file or a terminal you share.
import { Keypair } from '@stellar/stellar-sdk';

const kp = Keypair.random();
const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
if (!r.ok) {
  console.error(`friendbot failed: ${r.status}`);
  process.exit(1);
}
console.error(`testnet sponsor public key: ${kp.publicKey()} (funded by friendbot)`);
process.stdout.write(kp.secret());
