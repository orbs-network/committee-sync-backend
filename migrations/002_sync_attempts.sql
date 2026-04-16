-- Sync attempts: one row per sync() call (success or failure) per chain per nonce.
-- Multiple failed rows for the same (chain, nonce) represent retries.
CREATE TABLE IF NOT EXISTS sync_attempts (
  id                 BIGSERIAL PRIMARY KEY,
  chain_name         TEXT NOT NULL,
  contract_address   TEXT NOT NULL,
  nonce              BIGINT NOT NULL,
  success            BOOLEAN NOT NULL,
  tx_hash            TEXT,
  gas_used           TEXT,
  effective_gas_price TEXT,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_attempts_chain_nonce
  ON sync_attempts(chain_name, nonce);

-- System errors: non-sync errors (committee fetch failures, config errors, crashes).
CREATE TABLE IF NOT EXISTS system_errors (
  id         BIGSERIAL PRIMARY KEY,
  error_type TEXT NOT NULL,
  message    TEXT NOT NULL,
  chain_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
