import express, { Request, Response } from 'express';
import * as path from 'path';
import {
  StatusResponse,
  ActivityLog,
  ErrorLog,
  ChainSyncStats,
  CommitteeData,
} from './types';
import {
  getLatestCommitteeForStatus,
  getSyncGrid,
  getSyncDetail,
  getChainSummary,
  getRecentSystemErrors,
  getNonceWithSignatures,
} from './db';
import { loadChainConfig, getCachedChains } from './config';
import { notifier } from './notifier';

export class StatusServer {
  private app: express.Application;
  private startTime: Date;
  private currentCommittee: CommitteeData | null = null;
  private syncStats: Map<string, ChainSyncStats> = new Map();
  private activityLog: ActivityLog[] = [];
  private errorLog: ErrorLog[] = [];
  private readonly MAX_ACTIVITY_LOGS = 100;
  private readonly MAX_ERROR_LOGS = 100;

  constructor(port: number) {
    this.app = express();
    this.startTime = new Date();
    this.setupRoutes();
    this.start(port);
  }

  private setupRoutes(): void {
    // Serve static HTML dashboard
    this.app.use(express.static(path.join(process.cwd(), 'public')));

    // Legacy JSON status endpoint
    this.app.get('/status', (req: Request, res: Response) => {
      res.json(this.getStatus());
    });

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok' });
    });

    // ── New API endpoints (DB-backed) ──

    this.app.get('/api/committee', async (_req: Request, res: Response) => {
      try {
        const data = await getLatestCommitteeForStatus();
        if (!data) {
          res.json({ nonce: null, members: [], signatures: [], createdAt: null });
          return;
        }
        res.json({
          nonce: data.nonce,
          members: data.committeeJson.members || [],
          config: data.committeeJson.config || [],
          signatures: data.signatures,
          createdAt: data.createdAt,
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch committee' });
      }
    });

    this.app.get('/api/sync-grid', async (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.query.limit as string) || 50;
        const grid = await getSyncGrid(limit);
        const summary = await getChainSummary();

        // Determine chain order: from chain.json, with ethereum first
        let chainOrder: string[] = [];
        try {
          const chains = getCachedChains() ?? loadChainConfig();
          chainOrder = chains.map((c) => c.chainName);
        } catch {
          // Fallback: use chains seen in grid data
          chainOrder = [...new Set(grid.map((g) => g.chainName))];
        }
        // Force ethereum first
        chainOrder = chainOrder.sort((a, b) => {
          if (a.toLowerCase() === 'ethereum') return -1;
          if (b.toLowerCase() === 'ethereum') return 1;
          return 0;
        });

        res.json({ grid, summary, chainOrder });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch sync grid' });
      }
    });

    this.app.get('/api/sync-detail', async (req: Request, res: Response) => {
      try {
        const chain = req.query.chain as string;
        const nonce = parseInt(req.query.nonce as string);
        if (!chain || isNaN(nonce)) {
          res.status(400).json({ error: 'chain and nonce query params required' });
          return;
        }
        const attempts = await getSyncDetail(chain, nonce);
        const committeeData = await getNonceWithSignatures(nonce);
        res.json({
          chain,
          nonce,
          attempts,
          committee: committeeData?.committeeJson || null,
          signatures: committeeData?.signatures || [],
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch sync detail' });
      }
    });

    this.app.get('/api/chain-summary', async (_req: Request, res: Response) => {
      try {
        const summary = await getChainSummary();
        res.json(summary);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch chain summary' });
      }
    });

    this.app.get('/api/errors', async (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.query.limit as string) || 50;
        const errors = await getRecentSystemErrors(limit);
        res.json(errors);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch errors' });
      }
    });
  }

  private start(port: number): void {
    this.app.listen(port, () => {
      console.log(`Status server listening on port ${port}`);
    });
  }

  // ── In-memory methods (kept for backward compat with /status) ──

  updateCommittee(committee: CommitteeData): void {
    this.currentCommittee = committee;
  }

  recordActivity(activity: ActivityLog): void {
    this.activityLog.unshift(activity);
    if (this.activityLog.length > this.MAX_ACTIVITY_LOGS) {
      this.activityLog = this.activityLog.slice(0, this.MAX_ACTIVITY_LOGS);
    }
  }

  recordError(error: ErrorLog): void {
    this.errorLog.unshift(error);
    if (this.errorLog.length > this.MAX_ERROR_LOGS) {
      this.errorLog = this.errorLog.slice(0, this.MAX_ERROR_LOGS);
    }
    notifier.error(error.type, error.message, { chain: error.chainName });
  }

  updateSyncStats(
    chainName: string,
    rpcUrl: string,
    contractAddress: string,
    success: boolean
  ): void {
    const key = `${rpcUrl}:${contractAddress}`;
    const existing = this.syncStats.get(key) || {
      chainName,
      rpcUrl,
      contractAddress,
      totalSyncs: 0,
      lastSync: null,
      lastSyncStatus: null,
    };

    existing.chainName = chainName;
    existing.totalSyncs += success ? 1 : 0;
    existing.lastSync = new Date().toISOString();
    existing.lastSyncStatus = success ? 'success' : 'error';

    this.syncStats.set(key, existing);
  }

  private getStatus(): StatusResponse {
    const uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);

    return {
      status: 'running',
      startTime: this.startTime.toISOString(),
      uptime,
      currentCommittee: {
        members: this.currentCommittee
          ? this.currentCommittee.members.map(m => m.ethAddress)
          : [],
        lastUpdated: this.currentCommittee
          ? new Date(this.currentCommittee.timestamp).toISOString()
          : null,
      },
      syncStats: Array.from(this.syncStats.values()),
      activity: this.activityLog,
      errors: this.errorLog,
    };
  }
}
