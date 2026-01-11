# Integration Guide (Host SimFi Backend)

This repository is NOT a standalone app. Integrate these modules into your existing backend.

## 1) Copy/Import modules
- `src/services/*` into your backend services folder
- `src/routes/rewardsRoutes.ts` into your backend routes folder

## 2) Apply schema patch
- Apply changes from `patches/schema_patch.ts` into your backend schema.

## 3) Run DB migration
Run against your backend Postgres:
- `psql "$DATABASE_URL" -f migrations/add_rewards_tables.sql`

## 4) Mount the route
Mount `rewardsRoutes` under `/api/rewards`.

## 5) Test (in host backend)
- GET `/api/rewards/status`
- POST `/api/rewards/run` with header `x-rewards-secret: <REWARDS_ADMIN_SECRET>`
