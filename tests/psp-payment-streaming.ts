import * as anchor from "@coral-xyz/anchor";
import {assert} from "chai"
import {
  Utxo,
  Transaction,
  TRANSACTION_MERKLE_TREE_KEY,
  TransactionParameters,
  Provider as LightProvider,
  confirmConfig,
  Action,
  IDL_VERIFIER_PROGRAM_TWO,
  User,
  ProgramUtxoBalance,
  airdropSol,
} from "light-sdk";
import {
  Keypair as SolanaKeypair,
  SystemProgram,
  PublicKey,
  Keypair,
} from "@solana/web3.js";

import { buildPoseidonOpt } from "circomlibjs";
import { BN } from "@coral-xyz/anchor";
import { IDL } from "../target/types/PspPaymentStreaming";
const path = require("path");

const verifierProgramId = new PublicKey(
  "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
);
var POSEIDON;

const RPC_URL = "http://127.0.0.1:8899";

describe("psp_payment_streaming", () => {
  process.env.ANCHOR_PROVIDER_URL = RPC_URL;
  process.env.ANCHOR_WALLET = process.env.HOME + "/.config/solana/id.json";

  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.local(RPC_URL, confirmConfig);
  anchor.setProvider(provider);

  before(async () => {
    POSEIDON = await buildPoseidonOpt();
  });

  it("Create and Spend Program Utxo ", async () => {
    const wallet = Keypair.generate();
    await airdropSol({
      provider,
      amount: 10_000_000,
      recipientPublicKey: wallet.publicKey,
    });

    // The light provider is a connection and wallet abstraction.
    // The wallet is used to derive the seed for your shielded keypair with a signature.
    const lightProvider = await LightProvider.init({ wallet, url: RPC_URL });

    const user: User = await User.init({ provider: lightProvider });

    const outputUtxoSol = new Utxo({
      poseidon: POSEIDON,
      assets: [SystemProgram.programId],
      account: user.account,
      amounts: [new BN(1_000_000)],
      appData: { releaseSlot: new BN(1) },
      appDataIdl: IDL,
      verifierAddress: verifierProgramId,
    });

    const testInputsShield = {
      utxo: outputUtxoSol,
      action: Action.SHIELD,
    };

    await user.storeAppUtxo({
      appUtxo: testInputsShield.utxo,
      action: testInputsShield.action,
    });

    const programUtxoBalance: Map<string, ProgramUtxoBalance> =
      await user.syncStorage(IDL);
    const shieldedUtxoCommitmentHash =
      testInputsShield.utxo.getCommitment(POSEIDON);
    const inputUtxo = programUtxoBalance
      .get(verifierProgramId.toBase58())
      .tokenBalances.get(testInputsShield.utxo.assets[1].toBase58())
      .utxos.get(shieldedUtxoCommitmentHash);

    Utxo.equal(POSEIDON, inputUtxo, testInputsShield.utxo);

    const circuitPath = path.join("build-circuit");
    const appParams = {
      inputs: { releaseSlot: new BN(1), currentSlot: new BN(1) },
      path: circuitPath,
      verifierIdl: IDL,
    };

    const txParams = new TransactionParameters({
      inputUtxos: [inputUtxo],
      transactionMerkleTreePubkey: TRANSACTION_MERKLE_TREE_KEY,
      recipientSol: SolanaKeypair.generate().publicKey,
      action: Action.UNSHIELD,
      poseidon: POSEIDON,
      relayer: lightProvider.relayer,
      transactionNonce: user.balance.transactionNonce,
      verifierIdl: IDL_VERIFIER_PROGRAM_TWO,
    });

    let tx = new Transaction({
      provider: lightProvider,
      params: txParams,
      appParams,
    });

    await tx.compile();
    await tx.getProof();
    await tx.getAppProof();
    let signature = await tx.sendAndConfirmTransaction();
    console.log("signature ", signature);
  });

  it.only("payment streaming ", async () =>{
    const circuitPath = path.join("build-circuit");
    const wallet = Keypair.generate();
    await airdropSol({
      provider,
      amount: 10_000_000,
      recipientPublicKey: wallet.publicKey,
    });

    // The light provider is a connection and wallet abstraction.
    // The wallet is used to derive the seed for your shielded keypair with a signature.
    const lightProvider = await LightProvider.init({ wallet, url: RPC_URL });
    const user: User = await User.init({ provider: lightProvider });

    // user account give account aes key
    class PaymentStreamClient {
      idl: anchor.Idl;
      endSlot?: BN;
      streamInitUtxo?: Utxo;
      latestStreamUtxo?: Utxo;
      poseidon: any;
      circuitPath: string;

      constructor(idl: anchor.Idl, poseidon: any, circuitPath: string, streamInitUtxo?: Utxo, latestStreamUtxo?: Utxo) {
        this.idl = idl;
        this.streamInitUtxo = streamInitUtxo;
        this.endSlot = streamInitUtxo?.appData.endSlot;
        this.latestStreamUtxo = latestStreamUtxo;
        this.poseidon = poseidon;
        this.circuitPath = circuitPath;
      }
      /**
       * Creates a streamPrograUtxo
       * @param amount 
       * @param timeInSlots 
       */
      setupSolStream(amount: BN, timeInSlots: BN, currentSlot: BN, account: Account) {
        if(this.streamInitUtxo)
          throw new Error("This stream client is already initialized");
        
        const endSlot = currentSlot.add(timeInSlots);
        this.endSlot = endSlot;
        const rate = amount.div(timeInSlots);
        const appData = {
          endSlot,
          rate
        };
        const streamInitUtxo =  new Utxo({
          poseidon: this.poseidon,
          assets: [SystemProgram.programId],
          account,
          amounts: [amount],
          appData,
          appDataIdl: this.idl,
          verifierAddress: TransactionParameters.getVerifierProgramId(this.idl),
        });
        this.streamInitUtxo = streamInitUtxo;
        this.latestStreamUtxo = streamInitUtxo;
        return streamInitUtxo;
      }

      collectStream(currentSlot: BN, action: Action) {
        
        if(!this.streamInitUtxo)
          throw new Error("Streaming client is not initialized with streamInitUtxo");
        if(currentSlot.gte(this.streamInitUtxo?.appData.endSlot)) {
          const currentSlotPrivate = this.streamInitUtxo.appData.endSlot;
          const diff = currentSlot.sub(currentSlotPrivate);
          const programParameters: ProgramParameters = {
            inputs: {
              currentSlotPrivate,
              currentSlot,
              diff,
              remainingAmount: new BN(0),
              isOutUtxo: new Array(4).fill(0),
              ...this.streamInitUtxo.appData
            },
            verifierIdl: IDL,
            path: circuitPath 
          }
          const inUtxo = this.latestStreamUtxo;
          if(action === Action.TRANSFER) {
            const outUtxo = new Utxo({
              assets: inUtxo.assets,
              amounts: [inUtxo.amounts[0].sub(new BN(100_000)), inUtxo.amounts[1]],
              account: inUtxo.account,
              poseidon: this.poseidon,
            })
            return {programParameters, inUtxo, outUtxo, action};
          }
          return {programParameters, inUtxo, action};
        } else {
          const remainingAmount = this.streamInitUtxo.appData?.endSlot.sub(currentSlot).mul(this.streamInitUtxo.appData?.rate)
          const programParameters: ProgramParameters = {
            inputs: {
              currentSlotPrivate: currentSlot,
              currentSlot,
              diff: new BN(0),
              remainingAmount: new BN(0),
              isOutUtxo: [1, 0, 0, 0],
              endSlot: this.endSlot,
              ...this.streamInitUtxo.appData
            },
            verifierIdl: IDL,
            path: circuitPath 
          }
          const outUtxo = new Utxo({
            poseidon: this.poseidon,
            assets: [SystemProgram.programId],
            account,
            amounts: [remainingAmount],
            appData: this.streamInitUtxo.appData,
            appDataIdl: this.idl,
            verifierAddress: TransactionParameters.getVerifierProgramId(this.idl),
          });
          const inUtxo = this.latestStreamUtxo;
          return {programParameters, outUtxo, inUtxo};
        }
      }

      updateLatestStreamUtxo(latestStreamUtxo: Utxo) {
        this.latestStreamUtxo = latestStreamUtxo;
      }
    }

    type ProgramParameters = {
      verifierIdl: anchor.Idl,
      inputs: any // object of proof and other inputs
      // proofInputs:
      // instructionInputs: 
      path: string
    }
    let client: PaymentStreamClient = new PaymentStreamClient(IDL, POSEIDON, circuitPath);
    const currentSlot = await provider.connection.getSlot("confirmed");
    const duration = 1;
    const streamInitUtxo = client.setupSolStream(new BN(1e9), new BN(duration),new BN(currentSlot), user.account);

    const testInputsSol1 = {
      utxo: streamInitUtxo,
      action: Action.SHIELD,
      poseidon: POSEIDON
    }

    console.log("storing streamInitUtxo");
    await user.storeAppUtxo({
      appUtxo: testInputsSol1.utxo,
      action: testInputsSol1.action,
    });
    await user.syncStorage(IDL);
    const utxo = await user.getUtxo(testInputsSol1.utxo.getCommitment(testInputsSol1.poseidon))!;
    assert.equal(utxo.status,"ready");
    Utxo.equal(POSEIDON, utxo.utxo, testInputsSol1.utxo);
    const currentSlot1 = await provider.connection.getSlot("confirmed");

    const {programParameters, inUtxo, outUtxo, action} = client.collectStream(new BN(currentSlot1), Action.TRANSFER);

    await user.executeAppUtxo({
      appUtxo: inUtxo,
      programParameters,
      action,
    });
    const balance = await user.getBalance();
    console.log("totalSolBalance ", balance.totalSolBalance.toString());
    assert.equal(outUtxo.amounts[0].toString(), balance.totalSolBalance.toString());
    console.log("inUtxo commitment: ", inUtxo.getCommitment(POSEIDON));
    
    // user.getProgramUtxoBalance(optionalAsset)
    // user.getUtxo(commitmentHash)
    // const programUtxos = await user.getProgramUtxos({idl: IDL});
    // const res1: Map<string, ProgramUtxoBalance> = await user.syncStorage(IDL);
    // console.log(res1);
    
    const utxoSpent = await user.getUtxo(testInputsSol1.utxo.getCommitment(testInputsSol1.poseidon), true, IDL)!;
    assert.equal(utxoSpent.status,"spent");

  })
  
});
