/**
 * Test script: sends a real sync() tx against a local Anvil fork.
 *
 * Prerequisites:
 *   anvil --fork-url "https://rpcman.orbs.network/rpc?chainId=1&appId=committee-sync-be"
 *
 * Usage:
 *   npx ts-node test-anvil.ts
 */
import 'dotenv/config';
import { loadEnvConfig } from './src/config';
import { PayloadFetcher } from './src/payload';
import { SignatureCollector, validateSignedPayloads } from './src/collector';
import { EVMSyncer, SyncPayload } from './src/sync';
import { Client, Node } from '@orbs-network/client';

const ANVIL_RPC = 'http://127.0.0.1:8545';

async function main() {
  const config = loadEnvConfig();

  // Initialize ORBS client
  const orbsClient = new Client(config.seedIP);
  if (process.env.DEV_NODE_HOST) {
    orbsClient.localNode = new Node({
      name: 'local_v5_dev',
      ip: process.env.DEV_NODE_HOST,
      port: 80,
      website: '',
      guardianAddress: '',
      nodeAddress: 'string',
      reputation: 1,
      effectiveStake: 1,
      enterTime: 0,
      weight: 1,
      inCommittee: true,
      teeHardware: false,
    });
  }

  console.log('Initializing ORBS client...');
  await orbsClient.init();
  if (!orbsClient.initialized()) {
    throw new Error('Failed to initialize ORBS client');
  }

  const fetcher = new PayloadFetcher(orbsClient);
  const collector = new SignatureCollector();
  const syncer = new EVMSyncer(config.signerPrivateKey, config.walletManagerUrl);

  const anvilChain = {
    chainName: 'anvil-fork',
    rpcUrl: ANVIL_RPC,
    contractAddress: '0x33333330Ae0EeAaE67970e7D86013Cf8Ac3a0FCC',
  };

  // Read current nonce from Anvil fork
  const currentNonce = await syncer.readContractNonce(anvilChain);
  console.log(`\nContract nonce on fork: ${currentNonce}`);
  const targetNonce = currentNonce + 1;

  // Collect signed payloads
  console.log(`\nCollecting signed payloads for nonce ${targetNonce}...`);
  const nodes = await fetcher.getCommitteeNodes();
  console.log(`Found ${nodes.length} committee node(s)`);

  const signedPayloads = await collector.collectSignedPayloads(nodes, targetNonce);
  console.log(`Collected ${signedPayloads.length} signed payload(s)`);

  const validated = validateSignedPayloads(signedPayloads);
  console.log(`Validated: ${validated.signatures.length} sig(s), payloadHash ${validated.payloadHash}`);
  console.log(`  committee: [${validated.committee.join(', ')}]`);
  console.log(`  config items: ${validated.config.length}`);

  const payload: SyncPayload = {
    committeeAddresses: validated.committee,
    config: validated.config,
    signatures: validated.signatures,
  };

  console.log('\n--- Sending sync() to Anvil fork ---');
  const result = await syncer.syncCommittee(anvilChain, payload);

  if (result.success) {
    console.log(`\n✓ SUCCESS! Tx hash: ${result.transactionHash}`);
    const newNonce = await syncer.readContractNonce(anvilChain);
    console.log(`Contract nonce after sync: ${newNonce}`);
  } else {
    console.error(`\n✗ FAILED: ${result.error}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
