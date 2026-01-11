/**
 * SimFi Rewards Engine (FINAL MERGED VERSION)
 * 
 * Design:
 * - Epochs are keyed by leaderboard_period_id (aligns with existing periods)
 * - Only REWARDS_POOL_BPS% of claimed fees go to rewards (default 50%)
 * - Treasury share tracked separately
 * - All state changes in db.transaction() for crash safety
 * - Sequential processing (one period at a time)
 * - Advisory lock with explicit unlock
 * 
 * Payout split: 1st 50%, 2nd 30%, 3rd 20% of rewards pot
 */

import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { and, desc, eq, inArray, lte, sql, lt, or } from "drizzle-orm";

import { db } from "./db";
import { bagsService } from "./bagsService";
import {
  leaderboardPeriods,
  rewardsEpochs,
  rewardsState,
  rewardsWinners,
  tradeHistory,
  users,
  type PayoutPlanEntry,
} from "@shared/schema";

neonConfig.webSocketConstructor = ws;

// =============================================================================
// Configuration
// =============================================================================
const ENGINE_TICK_MS = 60_000; // Check every minute
const LEADER_CHECK_MS = 30_000;
const STUCK_TIMEOUT_MS = 15 * 60_000; // 15 minutes
const REWARDS_ENGINE_LOCK_ID = 987654321;

const REWARDS_POOL_BPS = clamp(parseInt(process.env.REWARDS_POOL_BPS || "5000", 10), 0, 10000);
const MIN_TRADES = clamp(parseInt(process.env.REWARDS_MIN_TRADES || "3", 10), 0, 1000);
const VAULT_RESERVE_LAMPORTS = BigInt(process.env.VAULT_RESERVE_LAMPORTS || "50000000"); // 0.05 SOL
const DRY_RUN = process.env.REWARDS_DRY_RUN === "1" || process.env.REWARDS_DRY_RUN === "true";

const PAYOUT_WEIGHTS = [50n, 30n, 20n] as const;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// =============================================================================
// Types
// =============================================================================
type TopWallet = {
  wallet: string;
  profitLamports: bigint;
  tradeCount: number;
  userId: string;
};

export type RewardsStatus = {
  enabled: boolean;
  isLeader: boolean;
  isDryRun: boolean;
  vaultReady: boolean;
  vaultPubkey?: string;
  vaultBalance?: string;
  rewardsPoolBps: number;
  carryRewardsLamports: string;
  treasuryAccruedLamports: string;
  activePeriod?: {
    id: string;
    startTime: string;
    endTime: string;
    countdownSeconds: number;
  };
  lastProcessed?: {
    periodId: string | null;
    periodEnd: string | null;
  };
  lastEpoch?: {
    id: string;
    periodId: string;
    status: string;
    totalPaid: string;
    txSignature?: string;
    failureReason?: string;
  };
};

// =============================================================================
// Engine
// =============================================================================
class RewardsEngine {
  private timer: NodeJS.Timeout | null = null;
  private leaderTimer: NodeJS.Timeout | null = null;
  private isStopped = true;
  private isLeader = false;
  private isProcessing = false;
  private lockPool: Pool | null = null;
  private lockClient: any = null;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!this.isStopped) return;

    const ok = await bagsService.init();
    if (!ok) {
      console.warn("[rewards] Engine disabled - Bags service not configured");
      return;
    }

    this.isStopped = false;

    if (DRY_RUN) {
      console.log("[rewards] DRY RUN MODE - no real transactions");
    }
    console.log(`[rewards] Pool: ${REWARDS_POOL_BPS / 100}% of fees go to rewards`);

    this.lockPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await this.tryAcquireLock();

    if (this.leaderTimer) clearInterval(this.leaderTimer);
    if (this.timer) clearInterval(this.timer);

    this.leaderTimer = setInterval(() => {
      if (!this.isStopped) void this.checkLeadership();
    }, LEADER_CHECK_MS);

    this.timer = setInterval(() => {
      if (this.isLeader && !this.isStopped && !this.isProcessing) {
        void this.tick();
      }
    }, ENGINE_TICK_MS);

    // Initial tick
    if (this.isLeader) {
      void this.tick();
    }

    console.log("[rewards] Engine started");
  }

  async stop(): Promise<void> {
    this.isStopped = true;

    if (this.timer) clearInterval(this.timer);
    if (this.leaderTimer) clearInterval(this.leaderTimer);
    this.timer = null;
    this.leaderTimer = null;

    await this.releaseLock();

    if (this.lockPool) {
      try { await this.lockPool.end(); } catch {}
      this.lockPool = null;
    }

    console.log("[rewards] Engine stopped");
  }

  // ---------------------------------------------------------------------------
  // Advisory Lock
  // ---------------------------------------------------------------------------

  private async tryAcquireLock(): Promise<void> {
    if (!this.lockPool || this.lockClient) return;

    try {
      const client = await this.lockPool.connect();
      const result = await client.query(
        "SELECT pg_try_advisory_lock($1) as acquired",
        [REWARDS_ENGINE_LOCK_ID]
      );

      if (result.rows[0]?.acquired === true) {
        this.lockClient = client;
        this.isLeader = true;
        console.log("[rewards] Acquired leader lock");
      } else {
        client.release();
        this.isLeader = false;
      }
    } catch (e: any) {
      console.error("[rewards] Lock error:", e?.message);
      this.isLeader = false;
    }
  }

  private async releaseLock(): Promise<void> {
    if (this.lockClient) {
      try {
        // CRITICAL: Explicit unlock before release
        await this.lockClient.query("SELECT pg_advisory_unlock($1)", [REWARDS_ENGINE_LOCK_ID]);
      } catch {}
      try {
        this.lockClient.release();
      } catch {}
      this.lockClient = null;
    }
    this.isLeader = false;
  }

  private async checkLeadership(): Promise<void> {
    if (this.isStopped) return;

    if (this.isLeader && this.lockClient) {
      try {
        await this.lockClient.query("SELECT 1");
        return;
      } catch {
        await this.releaseLock();
      }
    }

    if (!this.isLeader && !this.isStopped) {
      await this.tryAcquireLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Main Tick
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // 1. Check for stuck epochs first
      await this.recoverStuckEpochs();

      // 2. Find next period to process
      await this.processNextPeriod();
    } catch (e: any) {
      console.error("[rewards] Tick error:", e?.message);
    } finally {
      this.isProcessing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  private async recoverStuckEpochs(): Promise<void> {
    const stuckThreshold = new Date(Date.now() - STUCK_TIMEOUT_MS);

    const [stuck] = await db
      .select()
      .from(rewardsEpochs)
      .where(
        and(
          or(eq(rewardsEpochs.status, "claiming"), eq(rewardsEpochs.status, "paying")),
          lt(rewardsEpochs.updatedAt, stuckThreshold)
        )
      )
      .limit(1);

    if (!stuck) return;

    console.log(`[rewards] Recovering stuck epoch ${stuck.id} (status: ${stuck.status})`);

    if (stuck.status === "claiming") {
      // Resume claiming - recompute inflow from balance delta
      if (stuck.beforeBalanceLamports !== null && bagsService.isReady()) {
        const currentBalance = await bagsService.getVaultBalance();
        const totalInflow = currentBalance > stuck.beforeBalanceLamports
          ? currentBalance - stuck.beforeBalanceLamports
          : 0n;
        const rewardInflow = (totalInflow * BigInt(REWARDS_POOL_BPS)) / 10000n;

        await db
          .update(rewardsEpochs)
          .set({
            afterBalanceLamports: currentBalance,
            totalInflowLamports: totalInflow,
            rewardInflowLamports: rewardInflow,
            treasuryInflowLamports: totalInflow - rewardInflow,
            claimCompletedAt: new Date(),
            status: "created", // Reset to continue
          })
          .where(eq(rewardsEpochs.id, stuck.id));
      } else {
        await db
          .update(rewardsEpochs)
          .set({ status: "failed", failureReason: "stuck_in_claiming_no_before_balance" })
          .where(eq(rewardsEpochs.id, stuck.id));
      }
    } else if (stuck.status === "paying") {
      // Check if tx landed
      if (stuck.payoutTxSignature && bagsService.isReady()) {
        const confirmed = await bagsService.verifyTransaction(stuck.payoutTxSignature);
        if (confirmed) {
          await this.finalizeEpoch(stuck.id, stuck.payoutTxSignature);
          return;
        }
      }

      // Retry if we have a plan
      if (stuck.payoutPlan && (stuck.payoutPlan as PayoutPlanEntry[]).length > 0) {
        await this.executePayout(stuck.id, stuck.payoutPlan as PayoutPlanEntry[]);
      } else {
        // No plan, mark failed and restore carry
        await db.transaction(async (tx) => {
          const [state] = await tx.select().from(rewardsState).where(eq(rewardsState.id, 1));
          await tx
            .update(rewardsState)
            .set({
              carryRewardsLamports: (state?.carryRewardsLamports ?? 0n) + (stuck.totalPotLamports ?? 0n),
            })
            .where(eq(rewardsState.id, 1));

          await tx
            .update(rewardsEpochs)
            .set({ status: "failed", failureReason: "stuck_in_paying_no_plan" })
            .where(eq(rewardsEpochs.id, stuck.id));
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sequential Period Processing
  // ---------------------------------------------------------------------------

  private async processNextPeriod(): Promise<void> {
    // Ensure state row exists
    await db.insert(rewardsState).values({ id: 1 }).onConflictDoNothing();

    const [state] = await db.select().from(rewardsState).where(eq(rewardsState.id, 1));
    const lastEndTime = state?.lastProcessedPeriodEnd;

    const now = new Date();

    // Find the next ended period we haven't processed
    let query = db
      .select()
      .from(leaderboardPeriods)
      .where(lte(leaderboardPeriods.endTime, now))
      .orderBy(leaderboardPeriods.endTime)
      .limit(1);

    if (lastEndTime) {
      // Get the first period that ended AFTER our last processed
      const periods = await db
        .select()
        .from(leaderboardPeriods)
        .where(
          and(
            lte(leaderboardPeriods.endTime, now),
            sql`${leaderboardPeriods.endTime} > ${lastEndTime}`
          )
        )
        .orderBy(leaderboardPeriods.endTime)
        .limit(1);

      if (periods.length === 0) return; // Nothing new to process

      await this.processEpochForPeriod(periods[0]);
    } else {
      // First run - process the most recently ended period
      const periods = await db
        .select()
        .from(leaderboardPeriods)
        .where(lte(leaderboardPeriods.endTime, now))
        .orderBy(desc(leaderboardPeriods.endTime))
        .limit(1);

      if (periods.length === 0) return;

      await this.processEpochForPeriod(periods[0]);
    }
  }

  private async processEpochForPeriod(
    period: typeof leaderboardPeriods.$inferSelect
  ): Promise<void> {
    // Check if epoch already exists for this period
    let [epoch] = await db
      .select()
      .from(rewardsEpochs)
      .where(eq(rewardsEpochs.leaderboardPeriodId, period.id));

    // If completed/skipped, just update lastProcessed
    if (epoch && ["completed", "skipped"].includes(epoch.status)) {
      await db
        .update(rewardsState)
        .set({
          lastProcessedPeriodId: period.id,
          lastProcessedPeriodEnd: period.endTime,
        })
        .where(eq(rewardsState.id, 1));
      return;
    }

    // If in claiming/paying, wait (recovery will handle it)
    if (epoch && ["claiming", "paying"].includes(epoch.status)) {
      return;
    }

    // Create epoch if doesn't exist
    if (!epoch) {
      await db
        .insert(rewardsEpochs)
        .values({
          leaderboardPeriodId: period.id,
          periodStart: period.startTime,
          periodEnd: period.endTime,
          rewardsPoolBps: REWARDS_POOL_BPS,
          status: "created",
        })
        .onConflictDoNothing();

      [epoch] = await db
        .select()
        .from(rewardsEpochs)
        .where(eq(rewardsEpochs.leaderboardPeriodId, period.id));
    }

    // Reset failed epoch to retry
    if (epoch?.status === "failed") {
      await db
        .update(rewardsEpochs)
        .set({ status: "created", failureReason: null })
        .where(eq(rewardsEpochs.id, epoch.id));
    }

    if (epoch && epoch.status === "created") {
      await this.processEpoch(epoch.id, period);
    }
  }

  // ---------------------------------------------------------------------------
  // Epoch Processing
  // ---------------------------------------------------------------------------

  private async processEpoch(
    epochId: string,
    period: typeof leaderboardPeriods.$inferSelect
  ): Promise<void> {
    console.log(`[rewards] Processing period ${period.id} (${period.startTime.toISOString()} - ${period.endTime.toISOString()})`);

    try {
      // PHASE 1: CLAIM
      let beforeBalance = 0n;
      if (bagsService.isReady()) {
        beforeBalance = await bagsService.getVaultBalance();
      }

      await db
        .update(rewardsEpochs)
        .set({
          status: "claiming",
          claimStartedAt: new Date(),
          beforeBalanceLamports: beforeBalance,
        })
        .where(eq(rewardsEpochs.id, epochId));

      let claimSigs: string[] = [];
      if (bagsService.isReady() && !DRY_RUN) {
        const result = await bagsService.claimFees();
        claimSigs = result.signatures;
      }

      let afterBalance = beforeBalance;
      if (bagsService.isReady()) {
        afterBalance = await bagsService.getVaultBalance();
      }

      const totalInflow = afterBalance > beforeBalance ? afterBalance - beforeBalance : 0n;
      const rewardInflow = (totalInflow * BigInt(REWARDS_POOL_BPS)) / 10000n;
      const treasuryInflow = totalInflow - rewardInflow;

      // PHASE 2: COMPUTE POT AND DECIDE (transactional)
      const result = await db.transaction(async (tx) => {
        const [state] = await tx.select().from(rewardsState).where(eq(rewardsState.id, 1));
        const carryIn = state?.carryRewardsLamports ?? 0n;
        const totalPot = carryIn + rewardInflow;

        // Update epoch with claim results
        await tx
          .update(rewardsEpochs)
          .set({
            claimCompletedAt: new Date(),
            claimTxSignatures: claimSigs,
            afterBalanceLamports: afterBalance,
            totalInflowLamports: totalInflow,
            rewardInflowLamports: rewardInflow,
            treasuryInflowLamports: treasuryInflow,
            carryInLamports: carryIn,
            totalPotLamports: totalPot,
          })
          .where(eq(rewardsEpochs.id, epochId));

        // Update treasury tracking
        await tx
          .update(rewardsState)
          .set({
            treasuryAccruedLamports: (state?.treasuryAccruedLamports ?? 0n) + treasuryInflow,
          })
          .where(eq(rewardsState.id, 1));

        console.log(
          `[rewards] Inflow: ${totalInflow} (reward: ${rewardInflow}, treasury: ${treasuryInflow}), Pot: ${totalPot}`
        );

        // Get top 3 wallets
        const top3 = await this.getTopWallets(period.startTime, period.endTime);

        if (top3.length < 3) {
          console.log(`[rewards] Only ${top3.length} eligible wallets, skipping (need 3)`);

          await tx
            .update(rewardsState)
            .set({
              carryRewardsLamports: totalPot,
              lastProcessedPeriodId: period.id,
              lastProcessedPeriodEnd: period.endTime,
            })
            .where(eq(rewardsState.id, 1));

          await tx
            .update(rewardsEpochs)
            .set({ status: "skipped", failureReason: "insufficient_eligible_wallets" })
            .where(eq(rewardsEpochs.id, epochId));

          return { skip: true };
        }

        // Check vault balance
        const fee = bagsService.estimatePayoutFee(3);
        const minRequired = totalPot + VAULT_RESERVE_LAMPORTS + fee;

        if (afterBalance < minRequired) {
          console.log(`[rewards] Vault ${afterBalance} < required ${minRequired}, skipping`);

          await tx
            .update(rewardsState)
            .set({
              carryRewardsLamports: totalPot,
              lastProcessedPeriodId: period.id,
              lastProcessedPeriodEnd: period.endTime,
            })
            .where(eq(rewardsState.id, 1));

          await tx
            .update(rewardsEpochs)
            .set({ status: "skipped", failureReason: "insufficient_vault_balance" })
            .where(eq(rewardsEpochs.id, epochId));

          return { skip: true };
        }

        // Build payout plan
        const plan = this.buildPayoutPlan(totalPot, top3);

        // CRITICAL: Atomically zero carry, store plan, mark paying
        await tx
          .update(rewardsState)
          .set({ carryRewardsLamports: 0n })
          .where(eq(rewardsState.id, 1));

        await tx
          .update(rewardsEpochs)
          .set({
            status: "paying",
            payoutPlan: plan,
            payoutStartedAt: new Date(),
            totalPaidLamports: totalPot,
          })
          .where(eq(rewardsEpochs.id, epochId));

        return { skip: false, plan, totalPot };
      });

      if (result.skip) return;

      // PHASE 3: EXECUTE PAYOUT
      await this.executePayout(epochId, result.plan!);
    } catch (e: any) {
      console.error(`[rewards] Epoch error:`, e?.message);

      // Try to restore state on error
      try {
        const [epoch] = await db.select().from(rewardsEpochs).where(eq(rewardsEpochs.id, epochId));
        if (epoch && epoch.status === "paying" && epoch.totalPotLamports) {
          await db.transaction(async (tx) => {
            const [state] = await tx.select().from(rewardsState).where(eq(rewardsState.id, 1));
            await tx
              .update(rewardsState)
              .set({
                carryRewardsLamports: (state?.carryRewardsLamports ?? 0n) + epoch.totalPotLamports!,
              })
              .where(eq(rewardsState.id, 1));

            await tx
              .update(rewardsEpochs)
              .set({ status: "failed", failureReason: e?.message })
              .where(eq(rewardsEpochs.id, epochId));
          });
        } else {
          await db
            .update(rewardsEpochs)
            .set({ status: "failed", failureReason: e?.message })
            .where(eq(rewardsEpochs.id, epochId));
        }
      } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // Payout
  // ---------------------------------------------------------------------------

  private async executePayout(epochId: string, plan: PayoutPlanEntry[]): Promise<void> {
    if (DRY_RUN) {
      console.log("[rewards] DRY RUN: Skipping payout");
      await this.finalizeEpoch(epochId, "DRY_RUN_NO_TX");
      return;
    }

    if (!bagsService.isReady()) {
      await this.finalizeEpoch(epochId, undefined);
      return;
    }

    const winners = plan.map((p) => ({
      wallet: p.wallet,
      lamports: BigInt(p.amountLamports),
    }));

    console.log(`[rewards] Paying ${winners.length} winner(s)...`);
    const result = await bagsService.sendPayout(winners);

    if (result.success && result.signature) {
      // Store signature immediately
      await db
        .update(rewardsEpochs)
        .set({ payoutTxSignature: result.signature })
        .where(eq(rewardsEpochs.id, epochId));

      await this.finalizeEpoch(epochId, result.signature);
    } else {
      // Payout failed - restore carry
      await db.transaction(async (tx) => {
        const [epoch] = await tx.select().from(rewardsEpochs).where(eq(rewardsEpochs.id, epochId));
        const [state] = await tx.select().from(rewardsState).where(eq(rewardsState.id, 1));

        if (epoch?.totalPotLamports) {
          await tx
            .update(rewardsState)
            .set({
              carryRewardsLamports: (state?.carryRewardsLamports ?? 0n) + epoch.totalPotLamports,
            })
            .where(eq(rewardsState.id, 1));
        }

        await tx
          .update(rewardsEpochs)
          .set({ status: "failed", failureReason: result.error || "payout_failed" })
          .where(eq(rewardsEpochs.id, epochId));
      });

      console.error("[rewards] Payout failed:", result.error);
    }
  }

  private async finalizeEpoch(epochId: string, txSignature: string | undefined): Promise<void> {
    const [epoch] = await db.select().from(rewardsEpochs).where(eq(rewardsEpochs.id, epochId));
    if (!epoch) return;

    const plan = (epoch.payoutPlan || []) as PayoutPlanEntry[];
    const totalPaid = epoch.totalPotLamports ?? 0n;

    await db.transaction(async (tx) => {
      // Insert winners
      if (plan.length > 0) {
        await tx.insert(rewardsWinners).values(
          plan.map((p) => ({
            epochId,
            rank: p.rank,
            walletAddress: p.wallet,
            userId: p.userId || null,
            profitLamports: BigInt(p.profitLamports || "0"),
            tradeCount: p.tradeCount || 0,
            payoutLamports: BigInt(p.amountLamports),
          }))
        ).onConflictDoNothing();
      }

      // Mark completed
      await tx
        .update(rewardsEpochs)
        .set({
          status: "completed",
          payoutCompletedAt: new Date(),
          payoutTxSignature: txSignature,
          totalPaidLamports: totalPaid,
        })
        .where(eq(rewardsEpochs.id, epochId));

      // Update state
      await tx
        .update(rewardsState)
        .set({
          lastProcessedPeriodId: epoch.leaderboardPeriodId,
          lastProcessedPeriodEnd: epoch.periodEnd,
        })
        .where(eq(rewardsState.id, 1));
    });

    console.log(`[rewards] Epoch completed: ${totalPaid} lamports paid`);
    for (const p of plan) {
      console.log(`  ${p.rank}. ${p.wallet.slice(0, 8)}...: ${p.amountLamports} lamports`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async getTopWallets(startTime: Date, endTime: Date): Promise<TopWallet[]> {
    const rows = await db
      .select({
        wallet: users.walletAddress,
        profitLamports: sql<string>`COALESCE(SUM(${tradeHistory.profitLoss}), 0)::text`,
        tradeCount: sql<number>`COUNT(${tradeHistory.id})::int`,
        userId: sql<string>`MIN(${users.id})`,
      })
      .from(tradeHistory)
      .innerJoin(users, eq(tradeHistory.userId, users.id))
      .where(
        and(
          sql`${tradeHistory.closedAt} >= ${startTime}`,
          sql`${tradeHistory.closedAt} < ${endTime}`
        )
      )
      .groupBy(users.walletAddress)
      .orderBy(desc(sql`COALESCE(SUM(${tradeHistory.profitLoss}), 0)`))
      .limit(20);

    return rows
      .map((r) => ({
        wallet: r.wallet,
        profitLamports: BigInt(r.profitLamports),
        tradeCount: r.tradeCount,
        userId: r.userId,
      }))
      .filter((r) => r.tradeCount >= MIN_TRADES)
      .filter((r) => r.profitLamports > 0n)
      .filter((r) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet))
      .slice(0, 3);
  }

  private buildPayoutPlan(potLamports: bigint, top3: TopWallet[]): PayoutPlanEntry[] {
    const a1 = (potLamports * PAYOUT_WEIGHTS[0]) / 100n;
    const a2 = (potLamports * PAYOUT_WEIGHTS[1]) / 100n;
    const a3 = potLamports - a1 - a2; // Remainder to 3rd (no dust)

    const amounts = [a1, a2, a3];

    return top3.map((w, i) => ({
      rank: (i + 1) as 1 | 2 | 3,
      wallet: w.wallet,
      amountLamports: amounts[i].toString(),
      userId: w.userId,
      profitLamports: w.profitLamports.toString(),
      tradeCount: w.tradeCount,
    }));
  }

  // ---------------------------------------------------------------------------
  // API Methods
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<RewardsStatus> {
    const vaultReady = bagsService.isReady();
    const vaultPubkey = bagsService.getVaultPublicKey()?.toBase58();

    let vaultBalance: string | undefined;
    if (vaultReady) {
      try {
        vaultBalance = (await bagsService.getVaultBalance()).toString();
      } catch {}
    }

    const [state] = await db.select().from(rewardsState).where(eq(rewardsState.id, 1));

    // Get active period
    const [activePeriod] = await db
      .select()
      .from(leaderboardPeriods)
      .orderBy(desc(leaderboardPeriods.endTime))
      .limit(1);

    const countdown = activePeriod
      ? Math.max(0, Math.floor((activePeriod.endTime.getTime() - Date.now()) / 1000))
      : 0;

    // Get last epoch
    const [lastEpoch] = await db
      .select()
      .from(rewardsEpochs)
      .orderBy(desc(rewardsEpochs.periodEnd))
      .limit(1);

    return {
      enabled: vaultReady,
      isLeader: this.isLeader,
      isDryRun: DRY_RUN,
      vaultReady,
      vaultPubkey,
      vaultBalance,
      rewardsPoolBps: REWARDS_POOL_BPS,
      carryRewardsLamports: (state?.carryRewardsLamports ?? 0n).toString(),
      treasuryAccruedLamports: (state?.treasuryAccruedLamports ?? 0n).toString(),
      activePeriod: activePeriod
        ? {
            id: activePeriod.id,
            startTime: activePeriod.startTime.toISOString(),
            endTime: activePeriod.endTime.toISOString(),
            countdownSeconds: countdown,
          }
        : undefined,
      lastProcessed: {
        periodId: state?.lastProcessedPeriodId || null,
        periodEnd: state?.lastProcessedPeriodEnd?.toISOString() || null,
      },
      lastEpoch: lastEpoch
        ? {
            id: lastEpoch.id,
            periodId: lastEpoch.leaderboardPeriodId,
            status: lastEpoch.status,
            totalPaid: (lastEpoch.totalPaidLamports ?? 0n).toString(),
            txSignature: lastEpoch.payoutTxSignature || undefined,
            failureReason: lastEpoch.failureReason || undefined,
          }
        : undefined,
    };
  }

  async getHistory(limit: number = 20): Promise<any[]> {
    const epochs = await db
      .select()
      .from(rewardsEpochs)
      .orderBy(desc(rewardsEpochs.periodEnd))
      .limit(clamp(limit, 1, 100));

    const epochIds = epochs.map((e) => e.id);

    const winners =
      epochIds.length > 0
        ? await db
            .select()
            .from(rewardsWinners)
            .where(inArray(rewardsWinners.epochId, epochIds))
        : [];

    const winnersByEpoch = new Map<string, any[]>();
    for (const w of winners) {
      const arr = winnersByEpoch.get(w.epochId) || [];
      arr.push({
        rank: w.rank,
        wallet: w.walletAddress,
        payout: w.payoutLamports.toString(),
        profit: w.profitLamports.toString(),
        trades: w.tradeCount,
      });
      winnersByEpoch.set(w.epochId, arr);
    }

    return epochs.map((e) => ({
      id: e.id,
      periodId: e.leaderboardPeriodId,
      periodStart: e.periodStart.toISOString(),
      periodEnd: e.periodEnd.toISOString(),
      status: e.status,
      totalPot: (e.totalPotLamports ?? 0n).toString(),
      totalPaid: (e.totalPaidLamports ?? 0n).toString(),
      txSignature: e.payoutTxSignature,
      failureReason: e.failureReason,
      winners: (winnersByEpoch.get(e.id) || []).sort((a: any, b: any) => a.rank - b.rank),
    }));
  }

  async runOnce(): Promise<{ ok: boolean; message?: string }> {
    if (!bagsService.isReady()) {
      return { ok: false, message: "Bags service not configured" };
    }
    if (!this.isLeader) {
      return { ok: false, message: "Not leader instance" };
    }
    if (this.isProcessing) {
      return { ok: false, message: "Already processing" };
    }

    try {
      await this.tick();
      return { ok: true, message: "Processing triggered" };
    } catch (e: any) {
      return { ok: false, message: e?.message };
    }
  }

  isLeaderInstance(): boolean {
    return this.isLeader;
  }
}

export const rewardsEngine = new RewardsEngine();
