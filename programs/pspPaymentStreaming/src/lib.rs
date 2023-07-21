pub mod light_utils;
pub use light_utils::*;
pub mod processor;
pub mod verifying_key;
pub use verifying_key::*;

use crate::processor::{
    process_psp_payment_streaming_instruction_first,
    process_psp_payment_streaming_instruction_third,
};
use anchor_lang::prelude::*;
pub use processor::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[constant]
pub const PROGRAM_ID: &str = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";

#[program]
pub mod pspPaymentStreaming {
    use anchor_lang::solana_program::keccak::hash;

    use super::*;

    /// This instruction is the first step of a shieled transaction.
    /// It creates and initializes a verifier state account to save state of a verification during
    /// computation verifying the zero-knowledge proof (ZKP). Additionally, it stores other data
    /// such as leaves, amounts, recipients, nullifiers, etc. to execute the protocol logic
    /// in the last transaction after successful ZKP verification. light_verifier_sdk::light_instruction::PspInstruction2
    pub fn psp_payment_streaming_instruction_first<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, PspInstructionFirst<'info>>,
        inputs: Vec<u8>,
    ) -> Result<()> {
        let inputs_des: InstructionDataPspInstructionFirst =
            InstructionDataPspInstructionFirst::try_deserialize_unchecked(&mut inputs.as_slice())?;
        let proof_a = [0u8; 64];
        let proof_b = [0u8; 128];
        let proof_c = [0u8; 64];
        let pool_type = [0u8; 32];
        let checked_inputs = vec![
            [
                vec![0u8],
                hash(&ctx.program_id.to_bytes()).try_to_vec()?[1..].to_vec(),
            ]
            .concat(),
            inputs_des.transaction_hash.to_vec(),
        ];
        process_psp_payment_streaming_instruction_first(
            ctx,
            &proof_a,
            &proof_b,
            &proof_c,
            &inputs_des.public_amount_spl,
            &inputs_des.input_nullifier,
            &inputs_des.output_commitment,
            &inputs_des.public_amount_sol,
            &checked_inputs,
            &inputs_des.encrypted_utxos,
            &pool_type,
            &inputs_des.root_index,
            &inputs_des.relayer_fee,
        )
    }

    pub fn psp_payment_streaming_instruction_second<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, PspInstructionSecond<'info>>,
        inputs: Vec<u8>,
    ) -> Result<()> {
        // cut off discriminator
        let vec = &inputs[8..];
        let _ = vec
            .chunks(32)
            .map(|input| {
                ctx.accounts
                    .verifier_state
                    .checked_public_inputs
                    .push(input.to_vec())
            })
            .collect::<Vec<_>>();
        Ok(())
    }

    /// This instruction is the third and final step of a shielded transaction.
    /// The proof is verified with the parameters saved in the first transaction.
    /// At successful verification protocol logic is executed.
    pub fn psp_payment_streaming_instruction_third<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, PspInstructionThird<'info>>,
        inputs: Vec<u8>,
    ) -> Result<()> {
        let inputs_des: InstructionDataPspInstructionThird =
            InstructionDataPspInstructionThird::try_deserialize(&mut inputs.as_slice())?;

        process_psp_payment_streaming_instruction_third(
            ctx,
            &inputs_des.proof_a_app,
            &inputs_des.proof_b_app,
            &inputs_des.proof_c_app,
            &inputs_des.proof_a,
            &inputs_des.proof_b,
            &inputs_des.proof_c,
        )
    }

    /// Close the verifier state to reclaim rent in case the proofdata is wrong and does not verify.
    pub fn close_verifier_state<'a, 'b, 'c, 'info>(
        _ctx: Context<'a, 'b, 'c, 'info, CloseVerifierState<'info>>,
    ) -> Result<()> {
        Ok(())
    }
}
