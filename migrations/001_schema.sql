-- Committee nonces: one row per nonce with the committee+config payload
CREATE TABLE IF NOT EXISTS committee_nonces (
  nonce BIGINT PRIMARY KEY,
  committee_hash TEXT NOT NULL,
  committee_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Signatures per nonce: one row per guardian signature
CREATE TABLE IF NOT EXISTS committee_signatures (
  nonce BIGINT NOT NULL REFERENCES committee_nonces(nonce) ON DELETE CASCADE,
  guardian_address TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(nonce, guardian_address)
);

CREATE INDEX IF NOT EXISTS idx_committee_signatures_nonce ON committee_signatures(nonce);
