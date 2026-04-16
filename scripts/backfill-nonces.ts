/**
 * Backfill missing DB nonces by collecting fresh signatures from guardians.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/backfill-nonces.ts <chainName> [fromNonce] [toNonce]
 *
 * Examples:
 *   npx ts-node --transpile-only scripts/backfill-nonces.ts arbitrum
 *     → auto-detects: fromNonce = contractNonce+1, toNonce = DB latest
 *
 *   npx ts-node --transpile-only scripts/backfill-nonces.ts arbitrum 4 6
 *     → backfills nonces 4, 5, 6 explicitly
 *
 * What it does:
 *   1. For each missing nonce, collects signatures from the current committee
 *   2. Stores {nonce, committeeHash, committeeJson, signatures} in the DB
 *   3. Does NOT send any on-chain transactions — the catch-up loop handles that
 */

import 'dotenv/config';
import { loadEnvConfig, loadChainConfig } from '../src/config';
import { CommitteeFetcher } from '../src/committee';
import { SignatureCollector } from '../src/collector';
import { EVMSyncer } from '../src/sync';
import { Client, Node } from '@orbs-network/orbs-client';
import {
  initDb,
  runMigrations,
  storeSignedCommittee,
  getLatestStoredNonce,
  getNonceWithSignatures,
  closeDb,
} from '../src/db';
import { committeeHash } from '../src/hash';
import type { CommitteeSyncConfigItem } from '../src/types';

async function main() {
  const chainName = process.argv[2];
  if (!chainName) {
    console.error('Usage: npx ts-node --transpile-only scripts/backfill-nonces.ts <chainName> [fromNonce] [toNonce]');
    process.exit(1);
  }

  const config = loadEnvConfig();
  const chains = loadChainConfig();
  const chain = chains.find((c) => c.chainName.toLowerCase() === chainName.toLowerCase());
  if (!chain) {
    console.error(`Chain "${chainName}" not found in chain.json. Available: ${chains.map((c) => c.chainName).join(', ')}`);
    process.exit(1);
  }

  // Init DB
  initDb(config.db);
  await runMigrations();

  // Init ORBS client
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
  await orbsClient.init();

  const committeeFetcher = new CommitteeFetcher(orbsClient);
  const signatureCollector = new SignatureCollector();
  const evmSyncer = new EVMSyncer(config.privateKey);

  // Determine range
  const contractNonce = await evmSyncer.readContractNonce(chain);
  if (contractNonce === -1) {
    console.error(`Failed to read contract nonce for ${chain.chainName}`);
    process.exit(1);
  }

  const dbLatest = await getLatestStoredNonce();
  if (dbLatest === null) {
    console.error('No nonces in DB — nothing to backfill to');
    process.exit(1);
  }

  const fromNonce = process.argv[3] ? parseInt(process.argv[3], 10) : contractNonce + 1;
  const toNonce = process.argv[4] ? parseInt(process.argv[4], 10) : dbLatest;

  console.log(`Chain: ${chain.chainName}`);
  console.log(`Contract nonce: ${contractNonce}`);
  console.log(`DB latest nonce: ${dbLatest}`);
  console.log(`Backfilling nonces ${fromNonce}..${toNonce}`);
  console.log();

  // Fetch current committee and enrich with IPs
  const committee = await committeeFetcher.getCurrentCommittee();
  const committeeWithNodes = await committeeFetcher.enrichCommitteeWithNodeInfo(committee);
  console.log(`Committee: ${committee.members.length} member(s): ${committee.members.map((m) => m.orbsAddress).join(', ')}`);
  console.log();

  let backfilled = 0;
  let skipped = 0;

  for (let nonce = fromNonce; nonce <= toNonce; nonce++) {
    // Check if already in DB
    const existing = await getNonceWithSignatures(nonce);
    if (existing) {
      console.log(`Nonce ${nonce}: already in DB, skipping`);
      skipped++;
      continue;
    }

    console.log(`Nonce ${nonce}: collecting signatures...`);
    try {
      const signatures = await signatureCollector.collectSignatures(committeeWithNodes, nonce);
      console.log(`  Collected ${signatures.length} signature(s)`);

      const committeeJson = {
        members: committee.members,
        config: committee.config ?? [],
        timestamp: committee.timestamp,
      };
      const hash = committeeHash(committeeJson);

      await storeSignedCommittee(nonce, hash, committeeJson, signatures);
      console.log(`  Stored in DB ✓`);
      backfilled++;
    } catch (error) {
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log();
  console.log(`Done. Backfilled: ${backfilled}, Skipped (already in DB): ${skipped}`);
  console.log('The catch-up loop will pick these up on the next cycle.');
  await closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
