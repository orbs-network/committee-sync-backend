import express, { Request, Response } from 'express';
import {
  StatusResponse,
  ActivityLog,
  ErrorLog,
  ChainSyncStats,
  CommitteeData,
} from './types';

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
    this.app.get('/status', (req: Request, res: Response) => {
      res.json(this.getStatus());
    });

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok' });
    });
  }

  private start(port: number): void {
    this.app.listen(port, () => {
      console.log(`Status server listening on port ${port}`);
    });
  }

  updateCommittee(committee: CommitteeData): void {
    this.currentCommittee = committee;
  }

  recordActivity(activity: ActivityLog): void {
    this.activityLog.unshift(activity); // Add to beginning
    if (this.activityLog.length > this.MAX_ACTIVITY_LOGS) {
      this.activityLog = this.activityLog.slice(0, this.MAX_ACTIVITY_LOGS);
    }
  }

  recordError(error: ErrorLog): void {
    this.errorLog.unshift(error); // Add to beginning
    if (this.errorLog.length > this.MAX_ERROR_LOGS) {
      this.errorLog = this.errorLog.slice(0, this.MAX_ERROR_LOGS);
    }
  }

  updateSyncStats(
    rpcUrl: string,
    contractAddress: string,
    success: boolean
  ): void {
    const key = `${rpcUrl}:${contractAddress}`;
    const existing = this.syncStats.get(key) || {
      rpcUrl,
      contractAddress,
      totalSyncs: 0,
      lastSync: null,
      lastSyncStatus: null,
    };

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
          ? this.currentCommittee.members.map(m => m.address)
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

