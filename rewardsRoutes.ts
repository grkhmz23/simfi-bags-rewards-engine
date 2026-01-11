/**
 * Rewards API Routes
 */

import { Router, Request, Response } from "express";
import { rewardsEngine } from "./rewardsEngine";

const router = Router();

// Serialize BigInt for JSON
function serialize(obj: any): any {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

/**
 * GET /api/rewards/status
 * Current status, vault balance, carry, active period countdown
 */
router.get("/status", async (_req: Request, res: Response) => {
  try {
    const status = await rewardsEngine.getStatus();
    res.json({ ok: true, ...serialize(status) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/**
 * GET /api/rewards/history
 * Past epochs with winners
 */
router.get("/history", async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const history = await rewardsEngine.getHistory(limit);
    res.json({ ok: true, history: serialize(history) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/**
 * GET /api/rewards/rules
 * Display rules and config
 */
router.get("/rules", (_req: Request, res: Response) => {
  const poolBps = parseInt(process.env.REWARDS_POOL_BPS || "5000", 10);
  const minTrades = parseInt(process.env.REWARDS_MIN_TRADES || "3", 10);

  res.json({
    ok: true,
    rewardsPoolBps: poolBps,
    rewardsPoolPercent: poolBps / 100,
    payoutSplit: {
      first: 50,
      second: 30,
      third: 20,
    },
    eligibility: {
      minTrades,
      requirePositiveProfit: true,
    },
    description: `${poolBps / 100}% of claimed fees go to rewards pot. Top 3 wallets by profit (min ${minTrades} trades) split: 50% / 30% / 20%.`,
  });
});

/**
 * POST /api/rewards/run
 * Manual trigger (admin only)
 */
router.post("/run", async (req: Request, res: Response) => {
  const secret = process.env.REWARDS_ADMIN_SECRET || process.env.ADMIN_SECRET;
  const provided =
    (req.headers["x-admin-secret"] as string) ||
    (req.headers["x-rewards-secret"] as string) ||
    "";

  if (secret && provided !== secret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const result = await rewardsEngine.runOnce();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/**
 * GET /api/rewards/leader
 * Check if this instance is leader
 */
router.get("/leader", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    isLeader: rewardsEngine.isLeaderInstance(),
  });
});

export const rewardsRouter = router;

// Alternative export for compatibility
export function registerRewardsRoutes(app: any): void {
  app.use("/api/rewards", router);
  console.log("[rewards] Routes registered at /api/rewards");
}
