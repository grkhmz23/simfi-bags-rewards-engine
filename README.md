SimFi Rewards Engine

Automated fee-claiming and rewards distribution engine for SimFi token launches on Bags.fm.

This module claims creator fees from Bags.fm, allocates a configurable portion to a rewards pool, and automatically distributes rewards to top traders on the SimFi leaderboard at the end of each period.

Designed for correctness, crash safety, and real-money payouts.

What This Does

At the end of each leaderboard period, the Rewards Engine:

Claims creator fees for the SimFi token from Bags.fm

Allocates REWARDS_POOL_BPS% of the claimed fees to rewards (default: 50%)

Keeps the remaining fees as treasury (tracked explicitly)

Pays the top 3 wallets by profit on the leaderboard:

1st place: 50%

2nd place: 30%

3rd place: 20%

Ensures payouts are atomic, idempotent, and crash-safe

The engine runs automatically on a fixed schedule and can also be triggered manually by an admin.

Key Properties

Leaderboard-aligned
Rewards are strictly tied to existing leaderboard periods. No custom epochs, no drift between UI and payouts.

Wallet-based rewards
Winners are selected by wallet address. A wallet can only win once per period.

Treasury-safe
Only a configurable percentage of fees is ever paid out. Treasury balances are tracked separately and never accidentally distributed.

Crash-safe & idempotent
All state transitions are transactional. If the process crashes mid-cycle, it recovers safely without double-paying.

Single-leader execution
Uses PostgreSQL advisory locks to ensure only one instance performs payouts.

Repository Contents
File	Location	Description
add_rewards_tables.sql	migrations/	Database schema for rewards state, epochs, and winners
schema_patch.ts	—	Patch to apply to existing shared/schema.ts
bagsService.ts	server/services/	Bags SDK integration and Solana vault logic
rewardsEngine.ts	server/services/	Core rewards engine
rewardsRoutes.ts	server/services/	REST API endpoints
.env.rewards.example	root	Environment configuration
Architecture Overview
Leaderboard Period Ends
        ↓
Check if already processed
        ↓
Create rewards_epoch linked to leaderboard_period
        ↓
CLAIM PHASE
  - Read vault balance (before)
  - Claim Bags fees
  - Read vault balance (after)
  - Compute total inflow
  - Split into rewards + treasury
        ↓
DECISION PHASE (transactional)
  - Load unpaid carry
  - Compute total rewards pot
  - Select top 3 wallets by profit
  - If not eligible → carry forward
  - If insufficient vault balance → carry forward
  - Else → build payout plan and mark "paying"
        ↓
PAYOUT PHASE
  - Single Solana transaction with 3 transfers
  - On success → finalize and persist winners
  - On failure → restore carry and mark failed
        ↓
Update last processed leaderboard period

Installation & Integration
1. Install Dependencies
npm install @bagsfm/bags-sdk bs58

2. Run Database Migration
psql $DATABASE_URL -f migrations/add_rewards_tables.sql

3. Patch Schema

Apply schema_patch.ts to your existing shared/schema.ts:

Import jsonb from drizzle-orm/pg-core

Add rewards tables after telegramSessions

Add the exported reward types at the end

4. Add Service Files

Copy the following files into your backend:

server/services/bagsService.ts
server/services/rewardsEngine.ts
server/services/rewardsRoutes.ts

5. Wire the Engine

In routes.ts:

app.use("/api/rewards", rewardsRouter);


In index.ts (after app initialization):

rewardsEngine.start();

6. Configure Environment Variables

See .env.rewards.example.

Required:

BAGS_API_KEY

SOLANA_RPC_URL

REWARDS_VAULT_PRIVATE_KEY (base58)

REWARDS_TOKEN_MINT

Optional:

REWARDS_POOL_BPS (default: 5000 = 50%)

REWARDS_MIN_TRADES

REWARDS_VAULT_RESERVE_SOL

REWARDS_ADMIN_SECRET

7. Fund the Vault

Send SOL to the rewards vault wallet to cover:

Transaction fees

Initial payout liquidity

API Endpoints
Endpoint	Method	Auth	Description
/api/rewards/status	GET	None	Engine status, vault balance, carry
/api/rewards/history	GET	None	Past reward epochs and winners
/api/rewards/run	POST	Admin	Manually trigger processing
Testing & Local Use
# Optional: dry run (no on-chain payouts)
export REWARDS_DRY_RUN=1

npm run dev


Check status:

curl http://localhost:5000/api/rewards/status


Manual run:

curl -X POST http://localhost:5000/api/rewards/run \
  -H "x-rewards-secret: YOUR_SECRET"

Operational Notes

Watch for:

Growing carryRewardsLamports (periods skipped due to low activity)

Epochs with status = failed

isLeader = false on all instances (lock misconfiguration)

Low vault balance preventing payouts

Why This Matters (Hackathon Context)

This engine turns SimFi paper trading into real economic alignment:

Traders compete risk-free

Top performers earn real SOL rewards

Rewards are funded directly from token launch fees

No manual intervention, no trust assumptions

It demonstrates a full loop:
user activity → protocol revenue → automated, transparent redistribution
