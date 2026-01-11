export type PayoutPlanEntry = {
  rank: 1 | 2 | 3;
  wallet: string;
  amountLamports: string; // BigInt as string for JSON safety
  userId?: string | null;
  profitLamports?: string;
  tradeCount?: number;
};

export const rewardsState = pgTable("rewards_state", {
  id: integer("id").primaryKey().default(1),
  
  carryRewardsLamports: bigint("carry_rewards_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  treasuryAccruedLamports: bigint("treasury_accrued_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  
  lastProcessedPeriodId: varchar("last_processed_period_id").references(() => leaderboardPeriods.id),
  lastProcessedPeriodEnd: timestamp("last_processed_period_end"),
  
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const rewardsEpochs = pgTable("rewards_epochs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  leaderboardPeriodId: varchar("leaderboard_period_id").notNull().references(() => leaderboardPeriods.id),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  
  rewardsPoolBps: integer("rewards_pool_bps").notNull().default(5000),
  
  beforeBalanceLamports: bigint("before_balance_lamports", { mode: "bigint" }),
  afterBalanceLamports: bigint("after_balance_lamports", { mode: "bigint" }),
  
  totalInflowLamports: bigint("total_inflow_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  rewardInflowLamports: bigint("reward_inflow_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  treasuryInflowLamports: bigint("treasury_inflow_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  
  carryInLamports: bigint("carry_in_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  totalPotLamports: bigint("total_pot_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  
  claimStartedAt: timestamp("claim_started_at"),
  claimCompletedAt: timestamp("claim_completed_at"),
  claimTxSignatures: jsonb("claim_tx_signatures").$type<string[]>().default(sql`'[]'::jsonb`),
  
  payoutPlan: jsonb("payout_plan").$type<PayoutPlanEntry[]>().default(sql`'[]'::jsonb`),
  payoutStartedAt: timestamp("payout_started_at"),
  payoutCompletedAt: timestamp("payout_completed_at"),
  payoutTxSignature: text("payout_tx_signature"),
  totalPaidLamports: bigint("total_paid_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  
  status: varchar("status", { length: 20 }).notNull().default("created"),
  failureReason: text("failure_reason"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  periodUnique: unique("rewards_epochs_period_unique").on(t.leaderboardPeriodId),
}));

export const rewardsWinners = pgTable("rewards_winners", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  epochId: varchar("epoch_id").notNull().references(() => rewardsEpochs.id, { onDelete: "cascade" }),
  
  rank: integer("rank").notNull(),
  walletAddress: text("wallet_address").notNull(),
  userId: varchar("user_id").references(() => users.id),
  
  profitLamports: bigint("profit_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  tradeCount: integer("trade_count").notNull().default(0),
  payoutLamports: bigint("payout_lamports", { mode: "bigint" }).notNull().default(sql`0`),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  epochRankUnique: unique("rewards_winners_epoch_rank_unique").on(t.epochId, t.rank),
  epochWalletUnique: unique("rewards_winners_epoch_wallet_unique").on(t.epochId, t.walletAddress),
}));

export type RewardsState = typeof rewardsState.$inferSelect;
export type RewardsEpoch = typeof rewardsEpochs.$inferSelect;
export type RewardsWinner = typeof rewardsWinners.$inferSelect;
