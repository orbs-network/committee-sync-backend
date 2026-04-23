import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { ChainConfig, CommitteeSyncConfigItem, SignatureData } from './types';
import { sendToWalletManager } from './wallet-manager';

export interface SyncResult {
  success: boolean;
  transactionHash?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  error?: string;
}

export interface SyncPayload {
  committeeAddresses: string[];
  config: CommitteeSyncConfigItem[];
  signatures: SignatureData[];
}

export class EVMSyncer {
  private signerPrivateKey: string;
  private walletManagerUrl: string;
  private abi: any[];
  private iface: ethers.Interface;

  constructor(signerPrivateKey: string, walletManagerUrl: string) {
    this.signerPrivateKey = signerPrivateKey;
    this.walletManagerUrl = walletManagerUrl;
    this.abi = this.loadABI();
    this.iface = new ethers.Interface(this.abi);
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
      const n = Number(nonce);
      console.log(`[contract nonce] ${chain.chainName} (${chain.contractAddress}): ${n}`);
      return n;
    } catch (error) {
      console.error(`[contract nonce] ${chain.chainName} (${chain.contractAddress}): FAILED — ${error instanceof Error ? error.message : String(error)}`);
      return -1;
    }
  }

  async readContractCommittee(chain: ChainConfig): Promise<string[]> {
    try {
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
      const contract = new ethers.Contract(chain.contractAddress, this.abi, provider);
      const addresses: string[] = await contract.getCommittee();
      console.log(
        `[contract committee] ${chain.chainName} (${chain.contractAddress}): ${addresses.length} member(s) — ${addresses.join(', ')}`
      );
      return addresses.map((a) => a.toLowerCase());
    } catch (error) {
      console.error(
        `[contract committee] ${chain.chainName} (${chain.contractAddress}): FAILED — ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  async syncCommittee(
    chain: ChainConfig,
    payload: SyncPayload
  ): Promise<SyncResult> {
    try {
      const committeeAddresses = payload.committeeAddresses.map(a =>
        a.startsWith('0x') ? a : `0x${a}`
      );
      const signatureBytes = payload.signatures.map(sig =>
        sig.signature.startsWith('0x') ? sig.signature : `0x${sig.signature}`
      );
      const newConfig = payload.config ?? [];

      // Encode the sync() call data
      const txData = this.iface.encodeFunctionData('sync', [
        committeeAddresses,
        newConfig,
        signatureBytes,
      ]);

      console.log(`[wallet-manager] Encoding sync() for ${chain.chainName} → ${chain.contractAddress}`);

      const result = await sendToWalletManager(
        chain.contractAddress,
        txData,
        this.signerPrivateKey,
        this.walletManagerUrl,
        { chainName: chain.chainName, orderDuration: 300 },
      );

      if (result.error) {
        return {
          success: false,
          error: result.error,
        };
      }

      return {
        success: true,
        transactionHash: result.txHash,
        gasUsed: result.gasUsed,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
