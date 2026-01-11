# SimFi Rewards Engine - Final Merged Version

## Summary

This rewards engine:
- Runs at the end of each **leaderboard period** (aligned with your existing periods)
- Claims Bags.fm creator fees for your token
- Allocates **REWARDS_POOL_BPS%** (default 50%) to rewards, rest to treasury
- Pays top 3 wallets by profit: **50% / 30% / 20%**
- Is crash-safe with transactional state management

## Files

| File | Location | Description |
|------|----------|-------------|
| `add_rewards_tables.sql` | `migrations/` | Database migration |
| `schema_patch.ts` | N/A | Add to your existing `shared/schema.ts` |
| `bagsService.ts` | `server/services/` | Bags SDK + Solana vault |
| `rewardsEngine.ts` | `server/services/` | Core engine |
| `rewardsRoutes.ts` | `server/services/` | API endpoints |
| `.env.rewards.example` | Root | Environment variables |

## Integration Steps

### 1. Install Dependencies

```bash
npm install @bagsfm/bags-sdk bs58
```

### 2. Run Migration

```bash
psql $DATABASE_URL -f migrations/add_rewards_tables.sql
```

### 3. Patch Schema

Add the contents of `schema_patch.ts` to your `shared/schema.ts`:
- Ensure `jsonb` is imported from `drizzle-orm/pg-core`
- Add the tables after `telegramSessions`
- Add the type exports at the end

### 4. Add Service Files

Copy to `server/services/`:
- `bagsService.ts`
- `rewardsEngine.ts`
- `rewardsRoutes.ts`

### 5. Verify Integration

Your `routes.ts` should already have:
```typescript
import { registerRewardsRoutes } from "./services/rewardsRoutes";
import { rewardsEngine } from "./services/rewardsEngine";

// ... at the end of registerRoutes():
registerRewardsRoutes(app);
rewardsEngine.start();
```

### 6. Set Environment Variables

See `.env.rewards.example` for all options.

Required:
- `BAGS_API_KEY`
- `SOLANA_RPC_URL`
- `REWARDS_VAULT_PRIVATE_KEY`
- `REWARDS_TOKEN_MINT`

### 7. Fund Vault

Send some SOL to the vault wallet for transaction fees and initial liquidity.

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/rewards/status` | GET | None | Current status, vault, carry |
| `/api/rewards/history` | GET | None | Past epochs with winners |
| `/api/rewards/rules` | GET | None | Config and rules |
| `/api/rewards/run` | POST | Admin | Manual trigger |
| `/api/rewards/leader` | GET | None | Is this instance leader? |

## How It Works

```
Leaderboard period ends
         ↓
Check if already processed
         ↓
Create rewards_epoch linked to period
         ↓
CLAIM PHASE:
  - Record beforeBalance
  - Call Bags SDK to claim fees
  - Record afterBalance
  - Calculate totalInflow = after - before
  - rewardInflow = totalInflow × REWARDS_POOL_BPS / 10000
  - treasuryInflow = totalInflow - rewardInflow
         ↓
DECIDE PHASE (in transaction):
  - Get carry from state
  - totalPot = carry + rewardInflow
  - Get top 3 wallets by profit
  - If < 3 eligible: skip, add pot to carry
  - If vault < pot + reserve: skip, add pot to carry
  - Otherwise: build plan, zero carry, mark "paying"
         ↓
PAYOUT PHASE:
  - Send single tx with 3 transfers
  - On success: finalize, insert winners
  - On failure: restore carry, mark failed
         ↓
Update lastProcessedPeriodId
```

## Key Design Decisions

1. **Epochs keyed by `leaderboard_period_id`** - aligns rewards with your existing periods
2. **50% default to rewards** - configurable via `REWARDS_POOL_BPS`
3. **Treasury tracking** - `treasury_accrued_lamports` shows total kept
4. **Sequential processing** - only process next unprocessed period
5. **Crash recovery** - stuck epochs auto-recovered after 15 min
6. **Wallet-based uniqueness** - prevents same wallet winning twice per epoch

## Testing

```bash
# Enable dry run
export REWARDS_DRY_RUN=1

# Start server
npm run dev

# Check status
curl http://localhost:5000/api/rewards/status

# Manual trigger
curl -X POST http://localhost:5000/api/rewards/run \
  -H "x-admin-secret: YOUR_SECRET"

# Check history
curl http://localhost:5000/api/rewards/history
```

## Monitoring

Watch for:
- `carryRewardsLamports` growing (periods being skipped)
- `status: "failed"` epochs
- `isLeader: false` when you expect it to be true
- Low vault balance
