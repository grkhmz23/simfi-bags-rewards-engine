import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

// Max safe lamports for Number conversion (web3.js limitation)
const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

type ClaimResult = {
  success: boolean;
  signatures: string[];
  error?: string;
};

type PayoutResult = {
  success: boolean;
  signature?: string;
  error?: string;
};

type WinnerPayout = {
  wallet: string;
  lamports: bigint;
};

class BagsService {
  private connection: Connection | null = null;
  private keypair: Keypair | null = null;
  private tokenMint: string = "";
  private initialized = false;

  async init(): Promise<boolean> {
    const rpcUrl = process.env.SOLANA_RPC_URL;
    const vaultPrivateKey = process.env.REWARDS_VAULT_PRIVATE_KEY;
    const tokenMint = process.env.REWARDS_TOKEN_MINT;
    const apiKey = process.env.BAGS_API_KEY;

    if (!rpcUrl || !vaultPrivateKey || !tokenMint || !apiKey) {
      console.warn("[rewards] Bags service disabled - missing env vars");
      return false;
    }

    try {
      this.connection = new Connection(rpcUrl, "confirmed");
      this.keypair = Keypair.fromSecretKey(bs58.decode(vaultPrivateKey));
      this.tokenMint = tokenMint;

      // Test connection
      await this.connection.getLatestBlockhash("confirmed");
      this.initialized = true;

      console.log(`[rewards] Vault initialized: ${this.keypair.publicKey.toBase58()}`);
      return true;
    } catch (e: any) {
      console.error("[rewards] Bags init failed:", e?.message);
      return false;
    }
  }

  isReady(): boolean {
    return this.initialized && this.connection !== null && this.keypair !== null;
  }

  getVaultPublicKey(): PublicKey | null {
    return this.keypair?.publicKey || null;
  }

  async getVaultBalance(): Promise<bigint> {
    if (!this.connection || !this.keypair) {
      throw new Error("Bags service not initialized");
    }
    const balance = await this.connection.getBalance(this.keypair.publicKey, "confirmed");
    return BigInt(balance);
  }

  /**
   * Claim all fees for the configured token mint
   */
  async claimFees(): Promise<ClaimResult> {
    if (!this.isReady()) {
      return { success: false, signatures: [], error: "Service not initialized" };
    }

    try {
      const { BagsSDK, signAndSendTransaction } = await import("@bagsfm/bags-sdk");
      const apiKey = process.env.BAGS_API_KEY!;

      const sdk = new BagsSDK(apiKey, this.connection!, "confirmed");

      // Get claimable positions for our token
      const allPositions = await sdk.fee.getAllClaimablePositions(this.keypair!.publicKey);
      const positions = allPositions.filter((p: any) => p.baseMint === this.tokenMint);

      if (positions.length === 0) {
        console.log("[rewards] No claimable positions found");
        return { success: true, signatures: [] };
      }

      console.log(`[rewards] Found ${positions.length} claimable position(s)`);

      const signatures: string[] = [];

      for (const position of positions) {
        try {
          const txs = await sdk.fee.getClaimTransaction(this.keypair!.publicKey, position);

          for (const tx of txs || []) {
            try {
              const sig = await signAndSendTransaction(
                this.connection!,
                "confirmed",
                tx,
                this.keypair!
              );
              if (sig) {
                signatures.push(sig);
                console.log(`[rewards] Claim tx confirmed: ${sig}`);
              }
            } catch (txErr: any) {
              console.error("[rewards] Claim tx failed:", txErr?.message);
            }
          }
        } catch (posErr: any) {
          console.error("[rewards] Position claim failed:", posErr?.message);
        }
      }

      return { success: signatures.length > 0 || positions.length === 0, signatures };
    } catch (e: any) {
      console.error("[rewards] Claim fees error:", e?.message);
      return { success: false, signatures: [], error: e?.message };
    }
  }

  /**
   * Send SOL to multiple winners in a single transaction
   */
  async sendPayout(winners: WinnerPayout[]): Promise<PayoutResult> {
    if (!this.isReady()) {
      return { success: false, error: "Service not initialized" };
    }

    if (winners.length === 0) {
      return { success: true };
    }

    // Validate all payouts
    for (const w of winners) {
      if (w.lamports > MAX_SAFE_LAMPORTS) {
        return { success: false, error: `Payout ${w.lamports} exceeds safe limit for ${w.wallet}` };
      }
      if (w.lamports <= 0n) {
        return { success: false, error: `Invalid payout amount for ${w.wallet}` };
      }
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.wallet)) {
        return { success: false, error: `Invalid wallet address: ${w.wallet}` };
      }
    }

    try {
      const vault = this.keypair!.publicKey;

      const tx = new Transaction();
      for (const w of winners) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: vault,
            toPubkey: new PublicKey(w.wallet),
            lamports: Number(w.lamports), // Safe: validated above
          })
        );
      }

      tx.feePayer = vault;
      const { blockhash } = await this.connection!.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(this.keypair!);

      const signature = await this.connection!.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      await this.connection!.confirmTransaction(signature, "confirmed");

      console.log(`[rewards] Payout tx confirmed: ${signature}`);
      return { success: true, signature };
    } catch (e: any) {
      console.error("[rewards] Payout failed:", e?.message);
      return { success: false, error: e?.message };
    }
  }

  /**
   * Verify if a transaction signature is confirmed (for crash recovery)
   */
  async verifyTransaction(signature: string): Promise<boolean> {
    if (!this.connection) return false;

    try {
      const status = await this.connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });

      if (
        status?.value?.confirmationStatus === "confirmed" ||
        status?.value?.confirmationStatus === "finalized"
      ) {
        return true;
      }

      // Fallback: try to fetch the transaction
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      return tx !== null;
    } catch {
      return false;
    }
  }

  /**
   * Estimate fee for payout transaction
   */
  estimatePayoutFee(numWinners: number): bigint {
    // ~5000 lamports base + ~5000 per transfer + buffer
    return BigInt(5000 + numWinners * 5000 + 10000);
  }
}

export const bagsService = new BagsService();
