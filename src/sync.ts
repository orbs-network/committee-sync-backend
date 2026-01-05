import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { ChainConfig, CommitteeMember, SignatureData } from './types';

export interface SyncResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
}

export class EVMSyncer {
  private privateKey: string;
  private abi: any[];

  constructor(privateKey: string) {
    this.privateKey = privateKey;
    this.abi = this.loadABI();
  }

  private loadABI(): any[] {
    const abiPath = path.join(process.cwd(), 'abi.json');
    
    if (!fs.existsSync(abiPath)) {
      throw new Error(`abi.json file not found at ${abiPath}`);
    }

    try {
      const fileContent = fs.readFileSync(abiPath, 'utf-8');
      const abi = JSON.parse(fileContent);
      
      if (!Array.isArray(abi)) {
        throw new Error('ABI must be an array');
      }

      return abi;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in abi.json: ${error.message}`);
      }
      throw error;
    }
  }

  async syncCommittee(
    chain: ChainConfig,
    committee: CommitteeMember[],
    signatures: SignatureData[]
  ): Promise<SyncResult> {
    try {
      // Create provider and wallet
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
      const wallet = new ethers.Wallet(this.privateKey, provider);

      // Get contract instance
      const contract = new ethers.Contract(chain.contractAddress, this.abi, wallet);

      // Prepare committee addresses array
      const committeeAddresses = committee.map(m => m.address);

      // Prepare signatures array (ensure they're hex strings)
      const signatureBytes = signatures.map(sig => {
        const sigStr = sig.signature.startsWith('0x') ? sig.signature : `0x${sig.signature}`;
        // Remove 0x prefix for bytes array if needed, or keep it - depends on contract
        return sigStr;
      });

      // Ensure we have matching counts
      if (committeeAddresses.length !== signatureBytes.length) {
        throw new Error(
          `Mismatch: ${committeeAddresses.length} committee members but ${signatureBytes.length} signatures`
        );
      }

      // Estimate gas first
      let gasEstimate: bigint;
      try {
        gasEstimate = await contract.vote.estimateGas(committeeAddresses, signatureBytes);
      } catch (estimateError) {
        throw new Error(`Gas estimation failed: ${estimateError instanceof Error ? estimateError.message : String(estimateError)}`);
      }

      // Send transaction
      const tx = await contract.vote(committeeAddresses, signatureBytes, {
        gasLimit: gasEstimate + BigInt(10000), // Add buffer
      });

      // Wait for transaction receipt
      const receipt = await tx.wait();
      
      if (!receipt) {
        throw new Error('Transaction receipt is null');
      }

      return {
        success: true,
        transactionHash: receipt.hash,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

