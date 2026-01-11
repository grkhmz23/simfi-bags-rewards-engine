# Environment Variables

This repo is a reference implementation (not runnable). These variables are required in the host SimFi backend.

Required:
- DATABASE_URL
- BAGS_API_KEY
- SOLANA_RPC_URL
- REWARDS_VAULT_PRIVATE_KEY (base58 secret key)
- REWARDS_TOKEN_MINT
- REWARDS_ADMIN_SECRET

Optional/config:
- REWARDS_POOL_BPS (default 5000 = 50%)
- REWARDS_MIN_TRADES (default 3)
- REWARDS_VAULT_RESERVE_SOL (default 0.05)
