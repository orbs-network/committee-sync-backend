import 'dotenv/config';
import { loadEnvConfig, loadChainConfig, getCachedChains } from './config';
import { CommitteeFetcher } from './committee';
import { SignatureCollector } from './collector';
import { EVMSyncer } from './sync';
import { StatusServer } from './status';
import { ActivityLog, ErrorLog } from './types';

class CommitteeSyncService {
  private config: ReturnType<typeof loadEnvConfig>;
  private committeeFetcher: CommitteeFetcher;
  private signatureCollector: SignatureCollector;
  private evmSyncer: EVMSyncer;
  private statusServer: StatusServer;
  private isRunning = false;
  private checkIntervalId: NodeJS.Timeout | null = null;

  constructor() {
    // Load configuration
    this.config = loadEnvConfig();

    // Initialize components
    this.committeeFetcher = new CommitteeFetcher(this.config.seedIP);
    this.signatureCollector = new SignatureCollector(this.config.seedIP);
    this.evmSyncer = new EVMSyncer(this.config.privateKey);
    this.statusServer = new StatusServer(this.config.port);
  }

  async start(): Promise<void> {
    console.log('Starting Committee Sync Service...');

    try {
      // Initialize ORBS clients
      console.log('Initializing ORBS clients...');
      await this.committeeFetcher.init();
      await this.signatureCollector.init();
      console.log('ORBS clients initialized successfully');

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
      let committee;
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

      // Check if committee has changed
      const hasChanged = this.committeeFetcher.hasCommitteeChanged(committee);

      if (!hasChanged) {
        console.log('Committee has not changed, skipping sync');
        return;
      }

      console.log('Committee has changed, collecting signatures...');

      // Collect signatures
      let signatures;
      try {
        signatures = await this.signatureCollector.collectSignatures();
        console.log(`Collected ${signatures.length} signatures`);

        this.statusServer.recordActivity({
          timestamp: new Date().toISOString(),
          type: 'signature_collection',
          status: 'success',
          details: `Collected ${signatures.length} signatures`,
        });
      } catch (error) {
        const errorMsg = `Failed to collect signatures: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg);
        this.statusServer.recordError({
          timestamp: new Date().toISOString(),
          type: 'signature_collection',
          message: errorMsg,
        });
        return;
      }

      // Update status server with current committee
      this.statusServer.updateCommittee(committee);
      this.committeeFetcher.setLastCommittee(committee);

      // Sync to each chain
      console.log(`Syncing to ${chains.length} chain(s)...`);

      for (const chain of chains) {
        try {
          console.log(`Syncing to ${chain.rpcUrl}...`);
          const result = await this.evmSyncer.syncCommittee(
            chain,
            committee.members,
            signatures
          );

          if (result.success) {
            console.log(`✓ Successfully synced to ${chain.rpcUrl}. Tx: ${result.transactionHash}`);
            this.statusServer.updateSyncStats(chain.rpcUrl, chain.contractAddress, true);
            this.statusServer.recordActivity({
              timestamp: new Date().toISOString(),
              type: 'committee_sync',
              rpcUrl: chain.rpcUrl,
              contractAddress: chain.contractAddress,
              status: 'success',
              details: `Committee synced successfully. Tx: ${result.transactionHash}`,
            });
          } else {
            console.error(`✗ Failed to sync to ${chain.rpcUrl}: ${result.error}`);
            this.statusServer.updateSyncStats(chain.rpcUrl, chain.contractAddress, false);
            this.statusServer.recordError({
              timestamp: new Date().toISOString(),
              type: 'transaction',
              message: result.error || 'Unknown error',
              chain: chain.rpcUrl,
            });
            this.statusServer.recordActivity({
              timestamp: new Date().toISOString(),
              type: 'committee_sync',
              rpcUrl: chain.rpcUrl,
              contractAddress: chain.contractAddress,
              status: 'error',
              details: `Failed to sync: ${result.error}`,
            });
          }
        } catch (error) {
          const errorMsg = `Error syncing to ${chain.rpcUrl}: ${error instanceof Error ? error.message : String(error)}`;
          console.error(errorMsg);
          this.statusServer.updateSyncStats(chain.rpcUrl, chain.contractAddress, false);
          this.statusServer.recordError({
            timestamp: new Date().toISOString(),
            type: 'transaction',
            message: errorMsg,
            chain: chain.rpcUrl,
          });
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
