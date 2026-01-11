-- =============================================================================
-- SimFi Rewards Engine Tables (FINAL)
-- =============================================================================
-- Key design decisions:
-- 1. Epochs are keyed by leaderboard_period_id (not unix time)
-- 2. Only REWARDS_POOL_BPS% of claimed fees go to rewards (default 50%)
-- 3. Treasury share is tracked separately
-- 4. All lamports are BIGINT
-- =============================================================================

-- Singleton state row
CREATE TABLE IF NOT EXISTS rewards_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  
  -- Unpaid rewards pot carried forward
  carry_rewards_lamports BIGINT NOT NULL DEFAULT 0,
  
  -- Treasury/creator share accumulated (for accounting)
  treasury_accrued_lamports BIGINT NOT NULL DEFAULT 0,
  
  -- Last processed period (for sequential processing)
  last_processed_period_id VARCHAR REFERENCES leaderboard_periods(id),
  last_processed_period_end TIMESTAMP,
  
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO rewards_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One epoch per leaderboard period
CREATE TABLE IF NOT EXISTS rewards_epochs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  
  -- Link to leaderboard period (unique = one epoch per period)
  leaderboard_period_id VARCHAR NOT NULL REFERENCES leaderboard_periods(id),
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  
  -- Config snapshot
  rewards_pool_bps INTEGER NOT NULL DEFAULT 5000,
  
  -- Vault balance tracking
  before_balance_lamports BIGINT,
  after_balance_lamports BIGINT,
  
  -- Inflow breakdown
  total_inflow_lamports BIGINT NOT NULL DEFAULT 0,
  reward_inflow_lamports BIGINT NOT NULL DEFAULT 0,   -- goes to pot
  treasury_inflow_lamports BIGINT NOT NULL DEFAULT 0, -- kept as creator share
  
  -- Pot calculation
  carry_in_lamports BIGINT NOT NULL DEFAULT 0,
  total_pot_lamports BIGINT NOT NULL DEFAULT 0,
  
  -- Claim tracking
  claim_started_at TIMESTAMP,
  claim_completed_at TIMESTAMP,
  claim_tx_signatures JSONB NOT NULL DEFAULT '[]'::jsonb,
  
  -- Payout tracking
  payout_plan JSONB NOT NULL DEFAULT '[]'::jsonb,
  payout_started_at TIMESTAMP,
  payout_completed_at TIMESTAMP,
  payout_tx_signature TEXT,
  total_paid_lamports BIGINT NOT NULL DEFAULT 0,
  
  -- Status: created, claiming, paying, completed, skipped, failed
  status VARCHAR(20) NOT NULL DEFAULT 'created',
  failure_reason TEXT,
  
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  CONSTRAINT rewards_epochs_period_unique UNIQUE (leaderboard_period_id)
);

-- Winners per epoch
CREATE TABLE IF NOT EXISTS rewards_winners (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  epoch_id VARCHAR NOT NULL REFERENCES rewards_epochs(id) ON DELETE CASCADE,
  
  rank INTEGER NOT NULL CHECK (rank >= 1 AND rank <= 3),
  wallet_address TEXT NOT NULL,
  user_id VARCHAR REFERENCES users(id),
  
  profit_lamports BIGINT NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  payout_lamports BIGINT NOT NULL DEFAULT 0,
  
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  CONSTRAINT rewards_winners_epoch_rank_unique UNIQUE (epoch_id, rank),
  CONSTRAINT rewards_winners_epoch_wallet_unique UNIQUE (epoch_id, wallet_address)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rewards_epochs_status ON rewards_epochs(status);
CREATE INDEX IF NOT EXISTS idx_rewards_epochs_period_end ON rewards_epochs(period_end DESC);
CREATE INDEX IF NOT EXISTS idx_rewards_winners_epoch ON rewards_winners(epoch_id);

-- Updated_at triggers
CREATE OR REPLACE FUNCTION rewards_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rewards_epochs_updated_at ON rewards_epochs;
CREATE TRIGGER rewards_epochs_updated_at
  BEFORE UPDATE ON rewards_epochs
  FOR EACH ROW EXECUTE FUNCTION rewards_set_updated_at();

DROP TRIGGER IF EXISTS rewards_state_updated_at ON rewards_state;
CREATE TRIGGER rewards_state_updated_at
  BEFORE UPDATE ON rewards_state
  FOR EACH ROW EXECUTE FUNCTION rewards_set_updated_at();
