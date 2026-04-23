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
import { CommitteeFetcher } from './src/committee';
import { SignatureCollector } from './src/collector';
import { EVMSyncer, SyncPayload } from './src/sync';
import { Client, Node } from '@orbs-network/client';
import type { CommitteeSyncConfigItem } from './src/types';

const ANVIL_RPC = 'http://127.0.0.1:8545';

async function main() {
  const config = loadEnvConfig();

  // Initialize ORBS client
  const orbsClient = new Client(config.seedIP);
  if (process.env.DEV_NODE_HOST) {
    (orbsClient as any).localNode = new Node({
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

  // Fetch committee
  const fetcher = new CommitteeFetcher(orbsClient);
  console.log('Fetching current committee...');
  const committee = await fetcher.getCurrentCommittee();
  console.log(`Got ${committee.members.length} members:`);
  committee.members.forEach((m, i) => {
    console.log(`  [${i}] eth=${m.ethAddress} orbs=${m.orbsAddress}`);
  });

  // Read current nonce from Anvil fork
  const syncer = new EVMSyncer(config.privateKey);
  const anvilChain = {
    chainName: 'anvil-fork',
    rpcUrl: ANVIL_RPC,
    contractAddress: '0x33333333142DcC8ffd27C331fA00E780735889ef',
  };

  const currentNonce = await syncer.readContractNonce(anvilChain);
  console.log(`\nContract nonce on fork: ${currentNonce}`);
  const targetNonce = currentNonce + 1;

  // Enrich with node IPs and collect signatures
  console.log(`\nCollecting signatures for nonce ${targetNonce}...`);
  const enriched = await fetcher.enrichCommitteeWithNodeInfo(committee);
  const collector = new SignatureCollector();
  const signatures = await collector.collectSignatures(enriched, targetNonce);
  console.log(`Collected ${signatures.length} signatures:`);
  signatures.forEach((s, i) => {
    console.log(`  [${i}] addr=${s.orbsAddress} sig=${s.signature.slice(0, 20)}...`);
  });

  // Build payload
  const committeeAddresses = committee.members.map((m) =>
    m.orbsAddress.startsWith('0x') ? m.orbsAddress : `0x${m.orbsAddress}`
  );
  const configItems = (committee.config ?? []) as CommitteeSyncConfigItem[];
  const payload: SyncPayload = {
    committeeAddresses,
    config: configItems,
    signatures,
  };

  console.log('\n--- Sending sync() to Anvil fork ---');
  console.log(`  addresses: [${committeeAddresses.map(a => a.slice(0, 10) + '...').join(', ')}]`);
  console.log(`  config items: ${configItems.length}`);
  console.log(`  signatures: ${signatures.length}`);

  // Send the tx
  const result = await syncer.syncCommittee(anvilChain, payload);

  if (result.success) {
    console.log(`\n✓ SUCCESS! Tx hash: ${result.transactionHash}`);
    const newNonce = await syncer.readContractNonce(anvilChain);
    console.log(`Contract nonce after sync: ${newNonce}`);
  } else {
    console.error(`\n✗ FAILED: ${result.error}`);

    // Try to get more detail with cast
    console.log('\nAttempting detailed trace with cast...');
    const { execSync } = require('child_process');
    try {
      // Encode the call data manually and use cast to trace
      const iface = new (require('ethers').Interface)(require('./abi.json'));
      const calldata = iface.encodeFunctionData('sync', [
        committeeAddresses,
        configItems,
        signatures.map(s => s.signature.startsWith('0x') ? s.signature : `0x${s.signature}`),
      ]);
      console.log(`\nCalldata: ${calldata.slice(0, 80)}...`);

      const traceOutput = execSync(
        `cast call ${anvilChain.contractAddress} ${calldata} --rpc-url ${ANVIL_RPC} --trace 2>&1`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );
      console.log('\n--- cast trace ---');
      console.log(traceOutput);
    } catch (castError: any) {
      console.log('cast output:', castError.stdout || castError.stderr || castError.message);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
