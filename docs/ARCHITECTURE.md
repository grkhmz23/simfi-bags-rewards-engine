# Architecture Overview

## Purpose
Reference implementation of a Rewards Engine that:
- Claims Bags.fm creator fees
- Allocates a configurable portion to rewards
- Pays winners (top wallets by profit) using a deterministic split
- Uses transactional DB state to be crash-safe

## Components
- `src/services/bagsService.ts`: Bags SDK + Solana vault interactions
- `src/services/rewardsEngine.ts`: Core allocation/settlement logic
- `src/routes/rewardsRoutes.ts`: HTTP endpoints to trigger and monitor runs
- `migrations/add_rewards_tables.sql`: Rewards tables/state
- `patches/*`: integration patches for host repo
