import * as fs from 'fs';
import * as path from 'path';
import { ChainConfig, AppConfig, DbConfig } from './types';

let cachedChains: ChainConfig[] | null = null;

function loadDbConfig(): DbConfig {
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '5432', 10);
  if (isNaN(port) || port <= 0) {
    throw new Error('DB_PORT must be a positive number');
  }
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || '';
  const database = process.env.DB_NAME || 'committee_sync';
  return { host, port, user, password, database };
}

export function loadEnvConfig(): AppConfig {
  const seedIP = process.env.SEED_IP;
  if (!seedIP) {
    throw new Error('SEED_IP environment variable is required');
  }

  const checkInterval = parseInt(process.env.CHECK_INTERVAL || '300', 10);
  if (isNaN(checkInterval) || checkInterval <= 0) {
    throw new Error('CHECK_INTERVAL must be a positive number');
  }

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }

  const port = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(port) || port <= 0) {
    throw new Error('PORT must be a positive number');
  }

  return {
    seedIP,
    checkInterval,
    privateKey,
    port,
    db: loadDbConfig(),
  };
}

export function loadChainConfig(): ChainConfig[] {
  const chainJsonPath = path.join(process.cwd(), 'chain.json');

  if (!fs.existsSync(chainJsonPath)) {
    throw new Error(`chain.json file not found at ${chainJsonPath}`);
  }

  try {
    const fileContent = fs.readFileSync(chainJsonPath, 'utf-8');
    const chains = JSON.parse(fileContent);

    if (!Array.isArray(chains)) {
      throw new Error('chain.json must be an array');
    }

    const validatedChains: ChainConfig[] = chains.map((chain, index) => {
      if (!Array.isArray(chain) || (chain.length !== 2 && chain.length !== 3)) {
        throw new Error(`Invalid chain entry at index ${index}: must be [chainName, rpcUrl, contractAddress] or [rpcUrl, contractAddress]`);
      }

      // Support both old format [rpcUrl, contractAddress] and new format [chainName, rpcUrl, contractAddress]
      let chainName: string;
      let rpcUrl: string;
      let contractAddress: string;

      if (chain.length === 3) {
        // New format: [chainName, rpcUrl, contractAddress]
        [chainName, rpcUrl, contractAddress] = chain;
      } else {
        // Old format: [rpcUrl, contractAddress] - use rpcUrl as chainName for backward compatibility
        [rpcUrl, contractAddress] = chain;
        chainName = rpcUrl; // Use rpcUrl as chainName for backward compatibility
      }

      if (typeof chainName !== 'string' || !chainName.trim()) {
        throw new Error(`Invalid chainName at index ${index}: must be a non-empty string`);
      }

      if (typeof rpcUrl !== 'string' || !rpcUrl.trim()) {
        throw new Error(`Invalid rpcUrl at index ${index}: must be a non-empty string`);
      }

      if (typeof contractAddress !== 'string' || !contractAddress.trim()) {
        throw new Error(`Invalid contractAddress at index ${index}: must be a non-empty string`);
      }

      return {
        chainName: chainName.trim(),
        rpcUrl: rpcUrl.trim(),
        contractAddress: contractAddress.trim(),
      };
    });

    cachedChains = validatedChains;
    return validatedChains;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in chain.json: ${error.message}`);
    }
    throw error;
  }
}

export function getCachedChains(): ChainConfig[] | null {
  return cachedChains;
}

/** Returns the chain with chainName "ethereum" (case-insensitive). Used as ground truth for nonce. */
export function getEvmChain(chains: ChainConfig[]): ChainConfig | null {
  return chains.find((c) => c.chainName.toLowerCase() === 'ethereum') ?? null;
}

