import 'dotenv/config';
import { initFileLogging } from './logger';
initFileLogging();
import { loadEnvConfig, loadChainConfig, getCachedChains, getEvmChain } from './config';
import { CommitteeFetcher } from './committee';
import { SignatureCollector, validateSignatureVoters } from './collector';
import { Client, Node } from '@orbs-network/client';
import { EVMSyncer } from './sync';
import { StatusServer } from './status';
import { initDb, runMigrations, storeSignedCommittee, getLatestStoredNonce, getNoncesInRange, getNonceWithSignatures, recordSyncAttempt, recordSystemError } from './db';
import { notifier } from './notifier';
import { committeeHash } from './hash';
import type { CommitteeData, CommitteeSyncConfigItem } from './types';

class CommitteeSyncService {
  private config: ReturnType<typeof loadEnvConfig>;
  private orbsClient: Client;
  private committeeFetcher: CommitteeFetcher;
  private signatureCollector: SignatureCollector;
  private evmSyncer: EVMSyncer;
  private statusServer: StatusServer;
  private isRunning = false;
  private isChecking = false;
  private checkIntervalId: NodeJS.Timeout | null = null;

  constructor() {
    // Load configuration
    this.config = loadEnvConfig();

    // Initialize components
    this.orbsClient = new Client(this.config.seedIP);
    if (process.env.DEV_NODE_HOST) {
      this.orbsClient.localNode = new Node({
        name: "local_v5_dev",
        ip: process.env.DEV_NODE_HOST,
        port: 80,
        website: "",
        guardianAddress: "",
        nodeAddress: "string",
        reputation: 1,
        effectiveStake: 1,
        enterTime: 0,
        weight: 1,
        inCommittee: true,
        teeHardware: false,
      });
    }

    this.committeeFetcher = new CommitteeFetcher(this.orbsClient);
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

      // Hydrate lastCommittee from DB so the first check doesn't falsely
      // detect a change just because in-memory state is empty after restart.
      const latestNonce = await getLatestStoredNonce();
      if (latestNonce !== null) {
        const stored = await getNonceWithSignatures(latestNonce);
        if (stored) {
          const members = stored.committeeJson.members.map((m: any) => ({
            ...m,
            ethAddress: m.ethAddress || '',
            orbsAddress: m.orbsAddress || '',
          }));
          this.committeeFetcher.setLastCommittee({
            members,
            config: (stored.committeeJson.config ?? []) as CommitteeSyncConfigItem[],
            timestamp: 0,
          });
          console.log(`Hydrated lastCommittee from DB (nonce ${latestNonce}, ${members.length} member(s))`);
        }
      } else {
        console.log('No stored committee in DB — first check will treat committee as new');
      }

      // Initialize ORBS client once
      console.log('Initializing ORBS client...');
      await this.orbsClient.init();
      if (!this.orbsClient.initialized()) {
        throw new Error('Failed to initialize ORBS client');
      }
      console.log('ORBS client initialized successfully');

      // Start periodic check loop
      this.isRunning = true;
      this.startCheckLoop();

      console.log(`Service started. Checking every ${this.config.checkInterval} seconds.`);
      console.log(`Status API available at http://localhost:${this.config.port}/status`);
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

      // Fetch current committee
      let committee: CommitteeData | undefined;
      try {
        committee = await this.committeeFetcher.getCurrentCommittee();
        console.log(`Fetched committee with ${committee.members.length} members`);

        this.statusServer.recordActivity({
          timestamp: new Date().toISOString(),
          type: 'committee_fetch',
          status: 'success',
          details: `Fetched committee with ${committee.members.length} members`,
        });
      } catch (error) {
        const errorMsg = `Failed to fetch committee: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg);
        this.statusServer.recordError({
          timestamp: new Date().toISOString(),
          type: 'committee_fetch',
          message: errorMsg,
        });
        return;
      }

      if (!committee) return;

      // Log fetched committee orbsAddresses for traceability
      console.log(
        `Committee orbsAddresses (${committee.members.length}): ` +
        committee.members.map((m) => m.orbsAddress).join(', ')
      );

      // Check if committee has changed
      const hasChanged = this.committeeFetcher.hasCommitteeChanged(committee);
      console.log(`hasCommitteeChanged: ${hasChanged}`);
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
          // cycle that collected but failed to sync, or from the backfill script).
          const existingPayload = await getNonceWithSignatures(newNonce);
          let signatures;
          let committeeJson;

          if (existingPayload) {
            console.log(`Nonce ${newNonce}: found existing signatures in DB (${existingPayload.signatures.length} sig(s)), skipping collection`);
            signatures = existingPayload.signatures;
            committeeJson = existingPayload.committeeJson;
          } else {
            console.log(`Committee has changed, collecting signatures for nonce ${newNonce} (contract at ${contractNonce})...`);

            const committeeWithNodes = await this.committeeFetcher.enrichCommitteeWithNodeInfo(committee);

            try {
              const rawSignatures = await this.signatureCollector.collectSignatures(committeeWithNodes, newNonce);
              console.log(`Collected ${rawSignatures.length} signatures`);
              signatures = validateSignatureVoters(rawSignatures);
              console.log(`Validated ${signatures.length} signatures (consensus reached)`);

              this.statusServer.recordActivity({
                timestamp: new Date().toISOString(),
                type: 'signature_collection',
                status: 'success',
                details: `Collected ${rawSignatures.length}, validated ${signatures.length} signatures for nonce ${newNonce}`,
              });
            } catch (error) {
              const errorMsg = `Failed to collect/validate signatures: ${error instanceof Error ? error.message : String(error)}`;
              console.error(errorMsg);
              this.statusServer.recordError({
                timestamp: new Date().toISOString(),
                type: 'signature_collection',
                message: errorMsg,
              });
            }

            committeeJson = {
              members: committee.members,
              config: committee.config ?? [],
              timestamp: committee.timestamp,
            };
          }

          if (signatures && signatures.length > 0) {
            const committeeAddresses = (committeeJson!.members as any[]).map((m: any) =>
              (m.orbsAddress as string).startsWith('0x') ? m.orbsAddress : `0x${m.orbsAddress}`
            );
            const config = (committee.config ?? []) as CommitteeSyncConfigItem[];
            const payload = { committeeAddresses, config, signatures };

            // Sync to Ethereum first: store only after successful on-chain update
            console.log(
              `${evmChain.chainName}: submitting fresh sync() for nonce ${newNonce} ` +
              `(${committeeAddresses.length} member(s), ${signatures.length} sig(s), ${config.length} config item(s))`
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
                `Nonce: ${newNonce} (${committee.members.length} members)`,
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

              // Update in-memory state immediately after successful on-chain sync,
              // regardless of DB outcome, to prevent false change detection next cycle.
              this.statusServer.updateCommittee(committee);
              this.committeeFetcher.setLastCommittee(committee);

              const hash = committeeHash(committeeJson as any);
              try {
                await storeSignedCommittee(newNonce, hash, committeeJson as any, signatures);
                console.log(`Stored signed committee for nonce ${newNonce} in DB`);
              } catch (dbError) {
                const errorMsg = `Failed to store signed committee: ${dbError instanceof Error ? dbError.message : String(dbError)}`;
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
        console.log('Committee has not changed');
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
              const config = (p.committeeJson.config ?? []) as CommitteeSyncConfigItem[];

              console.log(
                `${chain.chainName}: submitting sync() for nonce ${p.nonce} ` +
                `(${committeeAddresses.length} member(s), ${p.signatures.length} sig(s), ${config.length} config item(s))`
              );

              const result = await this.evmSyncer.syncCommittee(chain, {
                committeeAddresses,
                config,
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
service.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  service.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  service.stop();
  process.exit(0);
});
