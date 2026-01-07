import * as fs from 'fs';
import * as path from 'path';
import { ChainConfig, AppConfig } from './types';

let cachedChains: ChainConfig[] | null = null;

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
      if (!Array.isArray(chain) || chain.length !== 2) {
        throw new Error(`Invalid chain entry at index ${index}: must be [rpcUrl, contractAddress]`);
      }

      const [rpcUrl, contractAddress] = chain;

      if (typeof rpcUrl !== 'string' || !rpcUrl.trim()) {
        throw new Error(`Invalid rpcUrl at index ${index}: must be a non-empty string`);
      }

      if (typeof contractAddress !== 'string' || !contractAddress.trim()) {
        throw new Error(`Invalid contractAddress at index ${index}: must be a non-empty string`);
      }

      return {
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

