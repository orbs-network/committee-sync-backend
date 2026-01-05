export interface ChainConfig {
  rpcUrl: string;
  contractAddress: string;
}

export interface CommitteeMember {
  address: string;
  [key: string]: any; // Allow additional properties from ORBS
}

export interface CommitteeData {
  members: CommitteeMember[];
  timestamp: number;
}

export interface SignatureData {
  signature: string; // Hex-encoded signature
  nodeAddress: string;
}

export interface ActivityLog {
  timestamp: string;
  type: 'committee_sync' | 'signature_collection' | 'error' | 'committee_fetch' | 'config_reload';
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
}

export interface ChainSyncStats {
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

export interface AppConfig {
  seedIP: string;
  checkInterval: number;
  privateKey: string;
  port: number;
}

