import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { ChainConfig, CommitteeSyncConfigItem, SignatureData } from './types';

export interface SyncResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
}

export interface SyncPayload {
  committeeAddresses: string[];
  config: CommitteeSyncConfigItem[];
  signatures: SignatureData[];
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

  async readContractNonce(chain: ChainConfig): Promise<number> {
    try {
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
      const contract = new ethers.Contract(chain.contractAddress, this.abi, provider);
      const nonce = await contract.nonce();
      return Number(nonce);
    } catch (error) {
      console.error(`Failed to read contract nonce: ${error instanceof Error ? error.message : String(error)}`);
      return -1;
    }
  }

  async syncCommittee(
    chain: ChainConfig,
    payload: SyncPayload
  ): Promise<SyncResult> {
    try {
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
      const wallet = new ethers.Wallet(this.privateKey, provider);
      const contract = new ethers.Contract(chain.contractAddress, this.abi, wallet);

      const committeeAddresses = payload.committeeAddresses.map(a =>
        a.startsWith('0x') ? a : `0x${a}`
      );
      const signatureBytes = payload.signatures.map(sig =>
        sig.signature.startsWith('0x') ? sig.signature : `0x${sig.signature}`
      );
      const newConfig = payload.config ?? [];

      let gasEstimate: bigint;
      try {
        gasEstimate = await contract.sync.estimateGas(
          committeeAddresses,
          newConfig,
          signatureBytes
        );
      } catch (estimateError) {
        throw new Error(
          `Gas estimation failed: ${estimateError instanceof Error ? estimateError.message : String(estimateError)}`
        );
      }

      const tx = await contract.sync(
        committeeAddresses,
        newConfig,
        signatureBytes,
        { gasLimit: gasEstimate + BigInt(10000) }
      );

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

