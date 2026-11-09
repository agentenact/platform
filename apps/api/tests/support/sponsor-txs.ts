import { Account, Address, BASE_FEE, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { TESTNET } from '../../src/owner-client/testnet.js';

/** The passkey wallet deploy as the kit builds it with a custom deployer: one CreateContractV2, the deployer as source. */
export function walletDeployTx(source: string, o: { deployer?: string; wasmHash?: string; ownAuth?: 'same' | 'nested' | 'other'; fee?: string } = {}) {
  const op = Operation.createCustomContract({
    address: Address.fromString(o.deployer ?? source),
    wasmHash: Buffer.from(o.wasmHash ?? TESTNET.accountWasmHash, 'hex'),
    salt: Buffer.alloc(32, 7),
    constructorArgs: [xdr.ScVal.scvU32(1)],
  });
  const create = (op.body().invokeHostFunctionOp().hostFunction() as xdr.HostFunction).createContractV2();
  if (o.ownAuth) {
    const fn =
      o.ownAuth === 'other'
        ? xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TESTNET.usdcSac).toScAddress(), functionName: 'transfer', args: [] }),
          )
        : xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(create);
    const sub =
      o.ownAuth === 'nested'
        ? [new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TESTNET.usdcSac).toScAddress(), functionName: 'transfer', args: [] }),
            ),
            subInvocations: [],
          })]
        : [];
    op.body().invokeHostFunctionOp().auth([
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: sub }),
      }),
    ]);
  }
  return new TransactionBuilder(new Account(source, '10'), { fee: o.fee ?? BASE_FEE, networkPassphrase: TESTNET.passphrase }).addOperation(op).setTimeout(300).build();
}
