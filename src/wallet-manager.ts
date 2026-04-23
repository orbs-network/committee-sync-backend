import { ethers } from 'ethers';

const RPCM_URL = process.env.RPCM_URL || '';

export interface WalletManagerConfig {
  [chainId: string]: {
    chainName: string;
    [key: string]: unknown;
  };
}

export interface WalletManagerResult {
  txHash?: string;
  gasUsed?: string;
  gasUnits?: string;
  blockNumber?: number;
  error?: string;
}

/**
 * Send a transaction through the wallet-manager service.
 * The wallet-manager will execute the transaction on behalf of the whitelisted EOA.
 */
export async function sendToWalletManager(
  to: string,
  txData: string,
  signerPrivateKey: string,
  walletManagerUrl: string,
  networkConfig: { chainName: string; orderDuration: number },
): Promise<WalletManagerResult> {
  const wallet = new ethers.Wallet(signerPrivateKey);

  const data = {
    to,
    txData,
    deadline: Date.now() + networkConfig.orderDuration * 1000,
    network: networkConfig.chainName,
    sender: wallet.address,
    estimateOnly: false,
  };

  const dataStr = JSON.stringify(data);
  const signature = await wallet.signMessage(dataStr);

  console.log(`[wallet-manager] Sending TX to ${to} on ${networkConfig.chainName}`);

  try {
    const response = await fetch(walletManagerUrl + '/sendTransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataStr, signature }),
    });

    const res: any = await response.json();

    if (response.status !== 200 || !res || res.error || !res.txHash) {
      const errorMsg = res?.error || `HTTP ${response.status}`;
      console.error(`[wallet-manager] TX failed: ${errorMsg}`);
      return { error: errorMsg };
    }

    console.log(`[wallet-manager] TX success: ${res.txHash}`);
    return {
      txHash: res.txHash,
      gasUsed: res.gasUsed,
      gasUnits: res.gasUnits,
      blockNumber: res.blockNumber,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[wallet-manager] Request failed: ${errorMsg}`);
    return { error: errorMsg };
  }
}

/**
 * Wait for a transaction to be mined.
 */
export async function waitForTxMine(
  chainId: string,
  txHash: string,
  maxRetries = 20,
  waitTime = 15000,
): Promise<boolean> {
  const provider = new ethers.JsonRpcProvider(RPCM_URL + chainId);

  for (let i = 0; i < maxRetries; i++) {
    await new Promise((resolve) => setTimeout(resolve, waitTime));

    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        return receipt.status === 1;
      }
    } catch (error) {
      console.error(`Error getting receipt for ${txHash}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return false;
}
