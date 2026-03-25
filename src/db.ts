import { Pool, PoolClient } from 'pg';
import { SignatureData } from './types';

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
  const sqlPath = path.join(process.cwd(), 'migrations', '001_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');
  const p = getPool();
  await p.query(sql);
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
