export interface ChainConfig {
  chainName: string;
  rpcUrl: string;
  contractAddress: string;
}

export interface CommitteeMember {
  ethAddress: string;
  orbsAddress: string;
  /** Node IP for fetching signatures (required for collectSignatures) */
  ip?: string;
  /** Node port (default 80 if 0 or omitted) */
  port?: number;
  [key: string]: any; // Allow additional properties from ORBS
}

/** Per-member config for sync() - maps to CommitteeSyncConfig.Config */
export interface CommitteeSyncConfigItem {
  [key: string]: unknown;
}

export interface CommitteeData {
  members: CommitteeMember[];
  config?: CommitteeSyncConfigItem[];
  timestamp: number;
}

export interface CommitteePayloadWithNonce {
  nonce: number;
  members: CommitteeMember[];
  config?: CommitteeSyncConfigItem[];
  timestamp: number;
}

export interface SignatureData {
  signature: string; // Hex-encoded signature
  orbsAddress: string;
  committeeHash?: string; // Hash of the committee the guardian sees
}

export interface ActivityLog {
  timestamp: string;
  type: 'committee_sync' | 'signature_collection' | 'error' | 'committee_fetch' | 'config_reload';
  chainName?: string;
  rpcUrl?: string;
  contractAddress?: string;
  status: 'success' | 'error';
  details: string;
  node?: string;
}

export interface ErrorLog {
  timestamp: string;
  type: 'signature_collection' | 'transaction' | 'committee_fetch' | 'config' | 'other';
  message: string;
  node?: string;
  chain?: string;
  chainName?: string;
}

export interface ChainSyncStats {
  chainName: string;
  rpcUrl: string;
  contractAddress: string;
  totalSyncs: number;
  lastSync: string | null;
  lastSyncStatus: 'success' | 'error' | null;
}

export interface StatusResponse {
  status: 'running' | 'error';
  startTime: string;
  uptime: number;
  currentCommittee: {
    members: string[];
    lastUpdated: string | null;
  };
  syncStats: ChainSyncStats[];
  activity: ActivityLog[];
  errors: ErrorLog[];
}

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface AppConfig {
  seedIP: string;
  checkInterval: number;
  signerPrivateKey: string;
  walletManagerUrl: string;
  port: number;
  db: DbConfig;
}

