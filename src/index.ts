import 'dotenv/config';
import { initFileLogging } from './logger';
initFileLogging();
import { loadEnvConfig, loadChainConfig, getCachedChains, getEvmChain } from './config';
import { PayloadFetcher } from './payload';
import { SignatureCollector, validateSignedPayloads } from './collector';
import { Client, Node } from '@orbs-network/client';
import { EVMSyncer } from './sync';
import { StatusServer } from './status';
import { initDb, runMigrations, storeSignedCommittee, getLatestStoredNonce, getNoncesInRange, getNonceWithSignatures, recordSyncAttempt } from './db';
import { notifier } from './notifier';
import type { CommitteeSyncConfigItem } from './types';

class CommitteeSyncService {
  private config: ReturnType<typeof loadEnvConfig>;
  private orbsClient: Client;
  private payloadFetcher: PayloadFetcher;
  private signatureCollector: SignatureCollector;
  private evmSyncer: EVMSyncer;
  private statusServer: StatusServer;
  private isRunning = false;
  private isChecking = false;
  private checkIntervalId: NodeJS.Timeout | null = null;

  constructor() {
    // Load configuration
    this.config = loadEnvConfig();

    // Initialize ORBS client.
    //
    // Dev / subnet mode: DEV_NODE_HOST is set → inject a localNode and SKIP
    // seed discovery. getCommitteeNodes() will return only [localNode] —
    // perfect for a single-node subnet where there's no management-service.
    //
    // Prod / mainnet: DEV_NODE_HOST is unset → orbsClient.init() discovers
    // the mainnet committee from SEED_IP via management-service/status.
    // To switch to mainnet, simply unset DEV_NODE_HOST in .env.
    this.orbsClient = new Client(this.config.seedIP);
    if (process.env.DEV_NODE_HOST) {
      console.log(`Subnet mode: using DEV_NODE_HOST=${process.env.DEV_NODE_HOST} as localNode`);
      this.orbsClient.localNode = new Node({
        name: 'local_subnet',
        ip: process.env.DEV_NODE_HOST,
        port: 80,
        website: '',
        guardianAddress: '',
        nodeAddress: 'local_subnet',
        reputation: 1,
        effectiveStake: 1,
        enterTime: 0,
        weight: 1,
        inCommittee: true,
        teeHardware: false,
      });
    }

    this.payloadFetcher = new PayloadFetcher(this.orbsClient);
    this.signatureCollector = new SignatureCollector();
    this.evmSyncer = new EVMSyncer(this.config.signerPrivateKey, this.config.walletManagerUrl);
    this.statusServer = new StatusServer(this.config.port);
  }


  async start(): Promise<void> {
    console.log('Starting Committee Sync Service...');

    // Initialize Telegram notifier (no-op if env vars unset)
    notifier.init(this.config.telegramBotToken, this.config.telegramChatId);

    try {
      // Initialize database
      console.log('Initializing database...');
      initDb(this.config.db);
      await runMigrations();
      console.log('Database initialized successfully');

      // Hydrate last payload hash from DB so the first check doesn't falsely
      // detect a change just because in-memory state is empty after restart.
      const latestNonce = await getLatestStoredNonce();
      if (latestNonce !== null) {
        const stored = await getNonceWithSignatures(latestNonce);
        if (stored?.committeeHash) {
          this.payloadFetcher.setLastPayloadHash(stored.committeeHash);
          console.log(`Hydrated lastPayloadHash from DB (nonce ${latestNonce}, hash ${stored.committeeHash.slice(0, 10)}...)`);
        }
      } else {
        console.log('No stored payload in DB — first check will treat payload as new');
      }

      // Initialize ORBS client only when we need to discover mainnet nodes via
      // management-service. In subnet mode (localNode set) we skip this — the
      // subnet doesn't expose management-service and we don't need it anyway.
      if (this.orbsClient.localNode) {
        console.log('Skipping orbsClient.init() — using localNode only');
      } else {
        console.log('Initializing ORBS client...');
        await this.orbsClient.init();
        if (!this.orbsClient.initialized()) {
          throw new Error('Failed to initialize ORBS client');
        }
        console.log('ORBS client initialized successfully');
      }

      // Start periodic check loop
      this.isRunning = true;
      this.startCheckLoop();

      console.log(`Service started. Checking every ${this.config.checkInterval} seconds.`);
      console.log(`Status API available at http://localhost:${this.config.port}/status`);

      await notifier.success(
        'service started',
        `Checking every ${this.config.checkInterval}s`,
      );
    } catch (error) {
      console.error('Failed to start service:', error);
      this.statusServer.recordError({
        timestamp: new Date().toISOString(),
        type: 'other',
        message: `Failed to start service: ${error instanceof Error ? error.message : String(error)}`,
      });
      process.exit(1);
    }
  }

  private startCheckLoop(): void {
    // Run immediately on start
    this.performCheck().catch((error) => {
      console.error('Error in initial check:', error);
    });

    // Then run periodically
    this.checkIntervalId = setInterval(() => {
      this.performCheck().catch((error) => {
        console.error('Error in periodic check:', error);
      });
    }, this.config.checkInterval * 1000);
  }

  private async performCheck(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    if (this.isChecking) {
      console.log(`[${new Date().toISOString()}] Skipping check — previous cycle still running`);
      return;
    }
    this.isChecking = true;

    console.log(`[${new Date().toISOString()}] Starting committee check...`);

    try {
      // Reload chain configuration
      let chains;
      try {
        chains = loadChainConfig();
        this.statusServer.recordActivity({
          timestamp: new Date().toISOString(),
          type: 'config_reload',
          status: 'success',
          details: `Reloaded ${chains.length} chain(s)`,
        });
      } catch (error) {
        const errorMsg = `Failed to reload chain.json: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg);
        this.statusServer.recordError({
          timestamp: new Date().toISOString(),
          type: 'config',
          message: errorMsg,
        });
        // Use cached chains if available
        chains = getCachedChains();
        if (!chains || chains.length === 0) {
          console.error('No chain configuration available, skipping check');
          return;
        }
        console.log(`Using cached chain configuration (${chains.length} chain(s))`);
      }

      // Determine the reference nonce for change detection: the latest nonce
      // we've successfully synced (per DB). The lambda's hash is computed over
      // (nonce, committee, config), so we ask it for the hash at the same nonce
      // we last synced — if (committee, config) is unchanged, the hash matches
      // what we stored; if changed, it differs.
      const referenceNonce = await getLatestStoredNonce();
      let hasChanged: boolean;

      if (referenceNonce === null) {
        // Empty DB → no reference → force a sync to bootstrap state
        console.log('No prior sync in DB — forcing initial sync to establish baseline');
        hasChanged = true;
      } else {
        let currentHash: string;
        try {
          currentHash = await this.payloadFetcher.getSyncHash(referenceNonce);
          console.log(`Current syncHash at nonce ${referenceNonce}: ${currentHash}`);

          this.statusServer.recordActivity({
            timestamp: new Date().toISOString(),
            type: 'committee_fetch',
            status: 'success',
            details: `Fetched syncHash ${currentHash.slice(0, 10)}... at nonce ${referenceNonce}`,
          });
        } catch (error) {
          const errorMsg = `Failed to fetch syncHash: ${error instanceof Error ? error.message : String(error)}`;
          console.error(errorMsg);
          this.statusServer.recordError({
            timestamp: new Date().toISOString(),
            type: 'committee_fetch',
            message: errorMsg,
          });
          return;
        }

        hasChanged = this.payloadFetcher.hasSyncPayloadChanged(currentHash);
        console.log(`hasSyncPayloadChanged: ${hasChanged}`);
      }

      if (hasChanged) {
        const evmChain = getEvmChain(chains);
        if (!evmChain) {
          const errorMsg = 'Ethereum chain not found in chain.json (chainName "ethereum" required for nonce ground truth)';
          console.error(errorMsg);
          this.statusServer.recordError({
            timestamp: new Date().toISOString(),
            type: 'config',
            message: errorMsg,
          });
        } else {
          const contractNonce = await this.evmSyncer.readContractNonce(evmChain);
          if (contractNonce === -1) {
            console.error(`Failed to read contract nonce for ${evmChain.chainName}, skipping committee sync`);
            return;
          }
          const lastStored = await getLatestStoredNonce();
          if (lastStored !== null && lastStored > contractNonce) {
            console.error(
              `Invalid state: DB has nonce ${lastStored} but Ethereum contract is at ${contractNonce}. ` +
              'DB should only contain nonces successfully synced to Ethereum.'
            );
            this.statusServer.recordError({
              timestamp: new Date().toISOString(),
              type: 'other',
              message: `Invalid state: DB nonce ${lastStored} > contract nonce ${contractNonce}`,
            });
          }

          const newNonce = contractNonce + 1;

          // Check if we already have signatures for this nonce in DB (e.g. from a previous
          // cycle that collected but failed to sync).
          const existingPayload = await getNonceWithSignatures(newNonce);
          let validated: {
            committee: string[];
            config: CommitteeSyncConfigItem[];
            configEncoded: Array<[string, string, string]>;
            payloadHash: string;
            signatures: any[];
          } | undefined;

          if (existingPayload) {
            console.log(`Nonce ${newNonce}: found existing signed payload in DB (${existingPayload.signatures.length} sig(s)), skipping collection`);
            const members = existingPayload.committeeJson.members as any[];
            validated = {
              committee: members.map((m: any) =>
                m.orbsAddress.startsWith('0x') ? m.orbsAddress : `0x${m.orbsAddress}`
              ),
              config: (existingPayload.committeeJson.config ?? []) as CommitteeSyncConfigItem[],
              configEncoded: (existingPayload.committeeJson.configEncoded ?? []) as Array<[string, string, string]>,
              payloadHash: existingPayload.committeeHash,
              signatures: existingPayload.signatures,
            };
          } else {
            console.log(`Payload changed, collecting signed payloads for nonce ${newNonce} (contract at ${contractNonce})...`);

            try {
              const nodes = await this.payloadFetcher.getCommitteeNodes();
              const signedPayloads = await this.signatureCollector.collectSignedPayloads(nodes, newNonce);
              console.log(`Collected ${signedPayloads.length} signed payload(s)`);
              validated = validateSignedPayloads(signedPayloads);
              console.log(`Validated: ${validated.signatures.length} sig(s), payloadHash ${validated.payloadHash.slice(0, 10)}...`);

              this.statusServer.recordActivity({
                timestamp: new Date().toISOString(),
                type: 'signature_collection',
                status: 'success',
                details: `Collected ${signedPayloads.length}, validated ${validated.signatures.length} sig(s) for nonce ${newNonce}`,
              });
            } catch (error) {
              const errorMsg = `Failed to collect/validate signed payloads: ${error instanceof Error ? error.message : String(error)}`;
              console.error(errorMsg);
              this.statusServer.recordError({
                timestamp: new Date().toISOString(),
                type: 'signature_collection',
                message: errorMsg,
              });
            }
          }

          if (validated && validated.signatures.length > 0) {
            const committeeAddresses = validated.committee;
            // For the on-chain TX we use the wire-format (configEncoded).
            // The rich `config` is kept around to store in the DB for the dashboard.
            const payload = {
              committeeAddresses,
              config: validated.configEncoded as any,
              signatures: validated.signatures,
            };

            // Sync to Ethereum first: store only after successful on-chain update
            console.log(
              `${evmChain.chainName}: submitting fresh sync() for nonce ${newNonce} ` +
              `(${committeeAddresses.length} member(s), ${validated.signatures.length} sig(s), ${validated.configEncoded.length} config item(s))`
            );
            const evmResult = await this.evmSyncer.syncCommittee(evmChain, payload);

            // Record sync attempt to DB (success or failure)
            await recordSyncAttempt({
              chainName: evmChain.chainName,
              contractAddress: evmChain.contractAddress,
              nonce: newNonce,
              success: evmResult.success,
              txHash: evmResult.transactionHash,
              gasUsed: evmResult.gasUsed,
              effectiveGasPrice: evmResult.effectiveGasPrice,
              errorMessage: evmResult.error,
            });

            if (evmResult.success) {
              console.log(`✓ Synced nonce ${newNonce} to Ethereum. Tx: ${evmResult.transactionHash}`);
              notifier.success(
                'new committee',
                `Nonce: ${newNonce} (${committeeAddresses.length} members)`,
                evmResult.transactionHash ? [`https://etherscan.io/tx/${evmResult.transactionHash}`] : []
              );
              this.statusServer.updateSyncStats(
                evmChain.chainName,
                evmChain.rpcUrl,
                evmChain.contractAddress,
                true
              );
              this.statusServer.recordActivity({
                timestamp: new Date().toISOString(),
                type: 'committee_sync',
                chainName: evmChain.chainName,
                rpcUrl: evmChain.rpcUrl,
                contractAddress: evmChain.contractAddress,
                status: 'success',
                details: `Nonce ${newNonce} synced to Ethereum. Tx: ${evmResult.transactionHash}`,
              });

              // Update in-memory hash immediately after successful on-chain sync,
              // regardless of DB outcome, to prevent false change detection next cycle.
              this.payloadFetcher.setLastPayloadHash(validated.payloadHash);

              // Enrich addresses with node info for the dashboard, then store in DB.
              // Store both forms: rich `config` for human/dashboard display, plus
              // `configEncoded` (wire tuples) so we can replay the same payload
              // to other chains during catch-up.
              const enrichedMembers = await this.payloadFetcher.enrichAddressesWithMemberInfo(committeeAddresses);
              const committeeJson = {
                members: enrichedMembers,
                config: validated.config,
                configEncoded: validated.configEncoded,
                timestamp: Date.now(),
              };
              this.statusServer.updateCommittee({ members: enrichedMembers, config: validated.config, timestamp: Date.now() });

              try {
                await storeSignedCommittee(newNonce, validated.payloadHash, committeeJson as any, validated.signatures);
                console.log(`Stored signed payload for nonce ${newNonce} in DB`);
              } catch (dbError) {
                const errorMsg = `Failed to store signed payload: ${dbError instanceof Error ? dbError.message : String(dbError)}`;
                console.error(errorMsg);
                this.statusServer.recordError({
                  timestamp: new Date().toISOString(),
                  type: 'other',
                  message: errorMsg,
                });
              }
            } else {
              console.error(`✗ Failed to sync nonce ${newNonce} to Ethereum: ${evmResult.error}`);
              this.statusServer.updateSyncStats(
                evmChain.chainName,
                evmChain.rpcUrl,
                evmChain.contractAddress,
                false
              );
              this.statusServer.recordError({
                timestamp: new Date().toISOString(),
                type: 'transaction',
                message: evmResult.error || 'Unknown error',
                chain: evmChain.rpcUrl,
                chainName: evmChain.chainName,
              });
            }
          }
        }
      } else {
        console.log('Sync payload has not changed');
      }

      // Sync missing nonces to each chain
      const latestStored = await getLatestStoredNonce();
      if (latestStored === null) {
        console.log('No signed committees in DB, skipping chain sync');
      } else {
        console.log(`Syncing chains (latest stored nonce: ${latestStored})...`);

        for (const chain of chains) {
          try {
            const contractNonce = await this.evmSyncer.readContractNonce(chain);
            if (contractNonce === -1) {
              console.error(`Failed to read contract nonce for ${chain.chainName}, skipping chain sync`);
              continue;
            }
            if (contractNonce >= latestStored) {
              console.log(`${chain.chainName}: contract nonce ${contractNonce} is up to date (DB latest: ${latestStored})`);
              continue;
            }

            const fromNonce = contractNonce + 1;
            const behindBy = latestStored - contractNonce;
            console.log(`${chain.chainName}: behind by ${behindBy} nonce(s) — contract at ${contractNonce}, DB latest ${latestStored}, syncing ${fromNonce}..${latestStored}`);
            const payloads = await getNoncesInRange(fromNonce, latestStored);
            console.log(`${chain.chainName}: loaded ${payloads.length} payload(s) from DB for catch-up`);

            for (const p of payloads) {
              const committeeAddresses = p.committeeJson.members.map((m) =>
                m.orbsAddress.startsWith('0x') ? m.orbsAddress : `0x${m.orbsAddress}`
              );
              // Use the encoded config (wire format tuples) for on-chain submission.
              const configEncoded = ((p.committeeJson as any).configEncoded ?? []) as Array<[string, string, string]>;

              console.log(
                `${chain.chainName}: submitting sync() for nonce ${p.nonce} ` +
                `(${committeeAddresses.length} member(s), ${p.signatures.length} sig(s), ${configEncoded.length} config item(s))`
              );

              const result = await this.evmSyncer.syncCommittee(chain, {
                committeeAddresses,
                config: configEncoded as any,
                signatures: p.signatures,
              });

              // Record sync attempt to DB
              await recordSyncAttempt({
                chainName: chain.chainName,
                contractAddress: chain.contractAddress,
                nonce: p.nonce,
                success: result.success,
                txHash: result.transactionHash,
                gasUsed: result.gasUsed,
                effectiveGasPrice: result.effectiveGasPrice,
                errorMessage: result.error,
              });

              if (result.success) {
                console.log(`✓ Synced nonce ${p.nonce} to ${chain.chainName}. Tx: ${result.transactionHash}`);
                this.statusServer.updateSyncStats(chain.chainName, chain.rpcUrl, chain.contractAddress, true);
                this.statusServer.recordActivity({
                  timestamp: new Date().toISOString(),
                  type: 'committee_sync',
                  chainName: chain.chainName,
                  rpcUrl: chain.rpcUrl,
                  contractAddress: chain.contractAddress,
                  status: 'success',
                  details: `Nonce ${p.nonce} synced. Tx: ${result.transactionHash}`,
                });
              } else {
                console.error(`✗ Failed to sync nonce ${p.nonce} to ${chain.chainName}: ${result.error}`);
                this.statusServer.updateSyncStats(chain.chainName, chain.rpcUrl, chain.contractAddress, false);
                this.statusServer.recordError({
                  timestamp: new Date().toISOString(),
                  type: 'transaction',
                  message: result.error || 'Unknown error',
                  chain: chain.rpcUrl,
                  chainName: chain.chainName,
                });
                break;
              }
            }
          } catch (error) {
            const errorMsg = `Error syncing ${chain.chainName}: ${error instanceof Error ? error.message : String(error)}`;
            console.error(errorMsg);
            this.statusServer.updateSyncStats(chain.chainName, chain.rpcUrl, chain.contractAddress, false);
            this.statusServer.recordError({
              timestamp: new Date().toISOString(),
              type: 'transaction',
              message: errorMsg,
              chain: chain.rpcUrl,
              chainName: chain.chainName,
            });
          }
        }
      }

      console.log('Committee check completed');
    } catch (error) {
      const errorMsg = `Unexpected error in committee check: ${error instanceof Error ? error.message : String(error)}`;
      console.error(errorMsg);
      this.statusServer.recordError({
        timestamp: new Date().toISOString(),
        type: 'other',
        message: errorMsg,
      });
    } finally {
      this.isChecking = false;
    }
  }

  stop(): void {
    console.log('Stopping Committee Sync Service...');
    this.isRunning = false;
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
  }
}

// Start the service
const service = new CommitteeSyncService();
service.start().catch(async (error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error('Fatal error:', error);
  await notifier.error('fatal', `Service crashed during startup: ${msg}`);
  process.exit(1);
});

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  await notifier.error('shutdown', `Service received ${signal} — shutting down`);
  service.stop();
  process.exit(0);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

// Catch unhandled exceptions
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);
  await notifier.error('crash', `Uncaught exception: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('Unhandled rejection:', reason);
  await notifier.error('crash', `Unhandled rejection: ${msg}`);
  process.exit(1);
});
