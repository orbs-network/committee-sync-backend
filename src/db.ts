import { Pool, PoolClient } from 'pg';
import { SignatureData } from './types';
import { notifier } from './notifier';

export interface CommitteePayload {
  nonce: number;
  committeeHash: string;
  committeeJson: {
    members: Array<{ ethAddress: string; orbsAddress: string;[key: string]: unknown }>;
    config?: unknown[];
    [key: string]: unknown;
  };
}

export interface StoredNonceWithSignatures {
  nonce: number;
  committeeHash: string;
  committeeJson: CommitteePayload['committeeJson'];
  signatures: SignatureData[];
}

let pool: Pool | null = null;

export function initDb(config: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): Pool {
  if (pool) return pool;
  pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });
  return pool;
}

export function getPool(): Pool {
  if (!pool) throw new Error('Database not initialized. Call initDb first.');
  return pool;
}

export async function runMigrations(): Promise<void> {
  const fs = await import('fs');
  const path = await import('path');
  const migrationsDir = path.join(process.cwd(), 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();
  const p = getPool();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await p.query(sql);
  }
}

export async function storeSignedCommittee(
  nonce: number,
  committeeHash: string,
  committeeJson: object,
  signatures: SignatureData[]
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await insertCommitteeNonce(client, nonce, committeeHash, committeeJson);
    for (const sig of signatures) {
      const orbsAddress =
        sig.orbsAddress?.startsWith('0x') ? sig.orbsAddress : `0x${sig.orbsAddress}`;
      const sigHex = sig.signature.startsWith('0x') ? sig.signature : `0x${sig.signature}`;
      await client.query(
        `INSERT INTO committee_signatures (nonce, guardian_address, signature)
         VALUES ($1, $2, $3)
         ON CONFLICT (nonce, guardian_address) DO UPDATE SET signature = EXCLUDED.signature`,
        [nonce, orbsAddress.toLowerCase(), sigHex]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function insertCommitteeNonce(
  client: PoolClient,
  nonce: number,
  committeeHash: string,
  committeeJson: object
): Promise<void> {
  await client.query(
    `INSERT INTO committee_nonces (nonce, committee_hash, committee_json)
     VALUES ($1, $2, $3)
     ON CONFLICT (nonce) DO UPDATE SET
       committee_hash = EXCLUDED.committee_hash,
       committee_json = EXCLUDED.committee_json`,
    [nonce, committeeHash, JSON.stringify(committeeJson)]
  );
}

export async function getLatestStoredNonce(): Promise<number | null> {
  const p = getPool();
  const res = await p.query(
    `SELECT nonce FROM committee_nonces ORDER BY nonce DESC LIMIT 1`
  );
  if (res.rows.length === 0) return null;
  return Number(res.rows[0].nonce);
}

export async function getNonceWithSignatures(
  nonce: number
): Promise<StoredNonceWithSignatures | null> {
  const p = getPool();
  const nonceRes = await p.query(
    `SELECT nonce, committee_hash, committee_json FROM committee_nonces WHERE nonce = $1`,
    [nonce]
  );
  if (nonceRes.rows.length === 0) return null;

  const row = nonceRes.rows[0];
  const sigRes = await p.query(
    `SELECT guardian_address, signature FROM committee_signatures WHERE nonce = $1 ORDER BY guardian_address`,
    [nonce]
  );

  const signatures: SignatureData[] = sigRes.rows.map((r: { guardian_address: string; signature: string }) => ({
    orbsAddress: r.guardian_address,
    signature: r.signature,
  }));

  return {
    nonce: Number(row.nonce),
    committeeHash: row.committee_hash,
    committeeJson: row.committee_json,
    signatures,
  };
}

export async function getNoncesInRange(
  fromNonce: number,
  toNonce: number
): Promise<StoredNonceWithSignatures[]> {
  const result: StoredNonceWithSignatures[] = [];
  for (let n = fromNonce; n <= toNonce; n++) {
    const data = await getNonceWithSignatures(n);
    if (data) result.push(data);
  }
  return result;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Sync Attempts ──

export interface SyncAttemptParams {
  chainName: string;
  contractAddress: string;
  nonce: number;
  success: boolean;
  txHash?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  errorMessage?: string;
}

export async function recordSyncAttempt(params: SyncAttemptParams): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO sync_attempts (chain_name, contract_address, nonce, success, tx_hash, gas_used, effective_gas_price, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.chainName,
      params.contractAddress,
      params.nonce,
      params.success,
      params.txHash ?? null,
      params.gasUsed ?? null,
      params.effectiveGasPrice ?? null,
      params.errorMessage ?? null,
    ]
  );
}

export async function recordSystemError(errorType: string, message: string, chainName?: string): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO system_errors (error_type, message, chain_name)
     VALUES ($1, $2, $3)`,
    [errorType, message, chainName ?? null]
  );
  notifier.error(errorType, message, { chain: chainName });
}

export interface SyncGridEntry {
  chainName: string;
  nonce: number;
  success: boolean;
  attempts: number;
  failedAttempts: number;
  latestTxHash: string | null;
  latestCreatedAt: string;
}

export async function getSyncGrid(limit = 50): Promise<SyncGridEntry[]> {
  const p = getPool();
  const res = await p.query(
    `SELECT
       chain_name,
       nonce,
       bool_or(success) AS success,
       COUNT(*)::int AS attempts,
       COUNT(*) FILTER (WHERE NOT success)::int AS failed_attempts,
       (SELECT tx_hash FROM sync_attempts s2
        WHERE s2.chain_name = sa.chain_name AND s2.nonce = sa.nonce AND s2.success = true
        ORDER BY s2.created_at DESC LIMIT 1) AS latest_tx_hash,
       MAX(created_at) AS latest_created_at
     FROM sync_attempts sa
     WHERE nonce >= (
       SELECT COALESCE(MAX(nonce), 0) - $1 FROM sync_attempts
     )
     GROUP BY chain_name, nonce
     ORDER BY nonce ASC, chain_name`,
    [limit]
  );
  return res.rows.map((r: any) => ({
    chainName: r.chain_name,
    nonce: Number(r.nonce),
    success: r.success,
    attempts: r.attempts,
    failedAttempts: r.failed_attempts,
    latestTxHash: r.latest_tx_hash,
    latestCreatedAt: r.latest_created_at,
  }));
}

export interface SyncDetailAttempt {
  id: number;
  success: boolean;
  txHash: string | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export async function getSyncDetail(chainName: string, nonce: number): Promise<SyncDetailAttempt[]> {
  const p = getPool();
  const res = await p.query(
    `SELECT id, success, tx_hash, gas_used, effective_gas_price, error_message, created_at
     FROM sync_attempts
     WHERE chain_name = $1 AND nonce = $2
     ORDER BY created_at ASC`,
    [chainName, nonce]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    success: r.success,
    txHash: r.tx_hash,
    gasUsed: r.gas_used,
    effectiveGasPrice: r.effective_gas_price,
    errorMessage: r.error_message,
    createdAt: r.created_at,
  }));
}

export interface ChainSummary {
  chainName: string;
  latestSyncedNonce: number | null;
  totalSuccesses: number;
  totalFailures: number;
  lastSyncAt: string | null;
}

export async function getChainSummary(): Promise<ChainSummary[]> {
  const p = getPool();
  const res = await p.query(
    `SELECT
       chain_name,
       MAX(nonce) FILTER (WHERE success) AS latest_synced_nonce,
       COUNT(*) FILTER (WHERE success)::int AS total_successes,
       COUNT(*) FILTER (WHERE NOT success)::int AS total_failures,
       MAX(created_at) AS last_sync_at
     FROM sync_attempts
     GROUP BY chain_name
     ORDER BY chain_name`
  );
  return res.rows.map((r: any) => ({
    chainName: r.chain_name,
    latestSyncedNonce: r.latest_synced_nonce != null ? Number(r.latest_synced_nonce) : null,
    totalSuccesses: r.total_successes,
    totalFailures: r.total_failures,
    lastSyncAt: r.last_sync_at,
  }));
}

export async function getRecentSystemErrors(limit = 50): Promise<Array<{
  id: number;
  errorType: string;
  message: string;
  chainName: string | null;
  createdAt: string;
}>> {
  const p = getPool();
  const res = await p.query(
    `SELECT id, error_type, message, chain_name, created_at
     FROM system_errors
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    errorType: r.error_type,
    message: r.message,
    chainName: r.chain_name,
    createdAt: r.created_at,
  }));
}

export async function getLatestCommitteeForStatus(): Promise<{
  nonce: number;
  committeeJson: any;
  signatures: SignatureData[];
  createdAt: string;
} | null> {
  const p = getPool();
  const nonceRes = await p.query(
    `SELECT nonce, committee_json, created_at FROM committee_nonces ORDER BY nonce DESC LIMIT 1`
  );
  if (nonceRes.rows.length === 0) return null;
  const row = nonceRes.rows[0];
  const sigRes = await p.query(
    `SELECT guardian_address, signature FROM committee_signatures WHERE nonce = $1 ORDER BY guardian_address`,
    [row.nonce]
  );
  const signatures: SignatureData[] = sigRes.rows.map((r: any) => ({
    orbsAddress: r.guardian_address,
    signature: r.signature,
  }));
  return {
    nonce: Number(row.nonce),
    committeeJson: row.committee_json,
    signatures,
    createdAt: row.created_at,
  };
}
