import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { decode as decodeBase64 } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import bs58 from "https://esm.sh/bs58@5.0.0";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "https://esm.sh/@solana/web3.js@1.95.3";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "https://esm.sh/@solana/spl-token@0.4.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DISTRIBUTION_INTERVAL_MINUTES = 5;
const PAYOUTS_PER_DAY = Math.floor((24 * 60) / DISTRIBUTION_INTERVAL_MINUTES);

type ListingWithOwner = {
  id: string;
  lot_number: number;
  tier: string;
  rent_yield: string | number | null;
  owner_user_id: string | null;
  owner?: {
    wallet_public_key?: string | null;
  } | null;
};

type AggregatedPayout = {
  amountTokens: number;
  propertyIds: string[];
  lots: number[];
};

const parseSecretKey = (raw: string): Uint8Array => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) {
      throw new Error("treasury_wallet JSON secret must be an array of numbers");
    }
    return Uint8Array.from(arr);
  }

  try {
    return bs58.decode(trimmed);
  } catch {
    // ignore and try base64
  }

  try {
    return decodeBase64(trimmed);
  } catch {
    throw new Error("treasury_wallet must be base58, base64, or a JSON array");
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tryParsePublicKey = (value: string) => {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("[distribute-treasury] Invocation start", {
      method: req.method,
      url: req.url,
      headers: Array.from(req.headers.entries()),
      ts: new Date().toISOString(),
    });
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const heliusKey = Deno.env.get("helius_key");
    const miiworldMint = Deno.env.get("miiworld_token");
    const treasurySecret = Deno.env.get("treasury_wallet");

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Missing Supabase service credentials");
    }
    if (!heliusKey) throw new Error("Missing helius_key secret");
    if (!miiworldMint) throw new Error("Missing miiworld_token secret");
    if (!treasurySecret) throw new Error("Missing treasury_wallet secret");

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const treasuryKeypair = Keypair.fromSecretKey(parseSecretKey(treasurySecret));
    const mintKey = new PublicKey(miiworldMint);
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    const connection = new Connection(heliusUrl, "confirmed");

    const mintAccount = await connection.getAccountInfo(mintKey, "confirmed");
    if (!mintAccount) {
      throw new Error(`Mint account not found for ${miiworldMint}`);
    }
    const programOwner = mintAccount.owner;
    const isTokenProgram = programOwner.equals(TOKEN_PROGRAM_ID);
    const isToken2022 = programOwner.equals(TOKEN_2022_PROGRAM_ID);
    if (!isTokenProgram && !isToken2022) {
      throw new Error(`Unsupported token program ${programOwner.toBase58()} for mint ${miiworldMint}`);
    }
    const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    console.log("[distribute-treasury] Mint detected", {
      mint: miiworldMint,
      program: tokenProgramId.toBase58(),
      token2022: isToken2022,
    });

    const mintInfo = await getMint(connection, mintKey, "confirmed", tokenProgramId);
    const mintDecimals = mintInfo.decimals;
    const decimalFactor = 10 ** mintDecimals;

    const { data: listings, error: listingsError } = await supabase
      .from("real_estate")
      .select("id, lot_number, tier, rent_yield, owner_user_id, owner:owner_user_id(wallet_public_key)")
      .not("owner_user_id", "is", null);

    if (listingsError) {
      console.error("[distribute-treasury] Failed to load property owners", listingsError);
      throw new Error(`Failed to load property owners: ${listingsError.message}`);
    }

    const payouts = new Map<string, AggregatedPayout>();
    for (const listing of (listings as ListingWithOwner[]) ?? []) {
      const walletRaw = listing.owner?.wallet_public_key?.trim();
      if (!walletRaw) continue;
      const ownerPubkey = tryParsePublicKey(walletRaw);
      if (!ownerPubkey) {
        console.warn("[distribute-treasury] Skipping listing with invalid wallet", {
          listingId: listing.id,
          wallet: walletRaw,
        });
        continue;
      }
      const wallet = ownerPubkey.toBase58();

      const rentYield = Number(listing.rent_yield ?? 0);
      if (!rentYield || Number.isNaN(rentYield)) continue;

      // Each run streams the full advertised rent_yield amount.
      const perRunTokens = rentYield;
      if (perRunTokens <= 0) continue;

      const entry = payouts.get(wallet) || { amountTokens: 0, propertyIds: [], lots: [] };
      entry.amountTokens += perRunTokens;
      entry.propertyIds.push(listing.id);
      entry.lots.push(listing.lot_number);
      payouts.set(wallet, entry);
    }

    if (payouts.size === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No eligible property owners found", payouts: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
      );
    }

    const treasuryAta = getAssociatedTokenAddressSync(
      mintKey,
      treasuryKeypair.publicKey,
      false,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const treasuryAtaInfo = await connection.getAccountInfo(treasuryAta);
    if (!treasuryAtaInfo) {
      const createTreasuryAta = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          treasuryKeypair.publicKey,
          treasuryAta,
          treasuryKeypair.publicKey,
          mintKey,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
      await sendAndConfirmTransaction(connection, createTreasuryAta, [treasuryKeypair], { commitment: "confirmed" });
      await sleep(500);
    }

    const successes: Array<{ wallet: string; amount: number; signature: string }> = [];
    const failures: Array<{ wallet: string; amount: number; reason: string }> = [];

    for (const [wallet, payload] of payouts) {
      try {
        const ownerPubkey = new PublicKey(wallet);
        const amountLamports = Math.floor(payload.amountTokens * decimalFactor);
        if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
          continue;
        }

        const ownerAta = getAssociatedTokenAddressSync(
          mintKey,
          ownerPubkey,
          false,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        const ownerAtaInfo = await connection.getAccountInfo(ownerAta);
        const tx = new Transaction();

        if (!ownerAtaInfo) {
          tx.add(
            createAssociatedTokenAccountInstruction(
              treasuryKeypair.publicKey,
              ownerAta,
              ownerPubkey,
              mintKey,
              tokenProgramId,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          );
        }

        tx.add(
          createTransferInstruction(
            treasuryAta,
            ownerAta,
            treasuryKeypair.publicKey,
            BigInt(amountLamports),
            [],
            tokenProgramId,
          ),
        );

        const signature = await sendAndConfirmTransaction(connection, tx, [treasuryKeypair], {
          commitment: "confirmed",
        });

        successes.push({ wallet, amount: payload.amountTokens, signature });
        console.log("[distribute-treasury] Transfer success", {
          wallet,
          amountTokens: payload.amountTokens,
          propertyIds: payload.propertyIds,
          signature,
        });

        try {
          const { error: insertError } = await supabase.from("token_distributions").insert({
            owner_wallet: wallet,
            listing_ids: payload.propertyIds,
            token_amount: payload.amountTokens,
            signature,
            solscan_url: `https://solscan.io/tx/${signature}`,
          });
          if (insertError) {
            console.error("[distribute-treasury] Failed to log distribution", insertError);
          }
        } catch (dbErr) {
          console.error("[distribute-treasury] Unexpected logging error", dbErr);
        }
      } catch (err: any) {
        failures.push({ wallet, amount: payload.amountTokens, reason: err?.message || "Unknown error" });
        console.error("[distribute-treasury] Transfer failed", {
          wallet,
          amountTokens: payload.amountTokens,
          propertyIds: payload.propertyIds,
          error: err,
        });
      }
    }

    const responseBody = {
      success: failures.length === 0,
      totalRecipients: payouts.size,
      distributed: successes.length,
      failed: failures.length,
      successes,
      failures,
    };
    console.log("[distribute-treasury] Invocation complete", responseBody);

    return new Response(
      JSON.stringify({
        ...responseBody,
        logTs: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: failures.length === 0 ? 200 : 207 },
    );
  } catch (error: any) {
    console.error("[distribute-treasury] Error", error);
    return new Response(
      JSON.stringify({ success: false, error: error?.message || "Unknown error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
    );
  }
});
