import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SOL_ADDRESS = "So11111111111111111111111111111111111111112";
const SWAP_BASE = "https://swap-v2.solanatracker.io";
const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_SOL_PURCHASE_BUFFER = 0.003;

interface PurchaseRequest {
  mode: "create" | "finalize";
  listingId: string;
  userId: string;
  buyerPubkey?: string;
  slippage?: number;
  priorityFee?: number | "auto";
  priorityFeeLevel?: "min" | "low" | "medium" | "high" | "veryHigh" | "unsafeMax";
  txid?: string;
  purchaseIntentId?: string;
}

type RateResponse = {
  rate?: {
    amountIn?: number;
    amountOut?: number;
  };
};

type SwapResponse = {
  txn: string;
  rate: any;
  type: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("[purchase-property] Incoming request");
    const body: PurchaseRequest = await req.json();
    const {
      mode,
      listingId,
      userId,
      buyerPubkey,
      slippage = 10,
      priorityFee = "auto",
      priorityFeeLevel = "medium",
      txid,
      purchaseIntentId,
    } = body;

    if (!mode || (mode !== "create" && mode !== "finalize")) {
      throw new Error("mode must be 'create' or 'finalize'");
    }
    if (!listingId || !userId) {
      throw new Error("listingId and userId are required");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const miiworldMint = Deno.env.get("miiworld_token");
    const heliusKey = Deno.env.get("helius_key");

    if (!miiworldMint) throw new Error("Missing miiworld_token secret");
    if (!heliusKey) throw new Error("Missing helius_key secret");

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const heliusRpc = async (method: string, params: any) => {
      const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
      const body = { jsonrpc: "2.0", id: `purchase-${method}`, method, params };
      const resp = await fetch(heliusUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      if (!resp.ok) {
        console.error(`[purchase-property] helius ${method} error`, resp.status, text);
        throw new Error(`Helius ${method} error: ${resp.status}`);
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        console.error(`[purchase-property] helius ${method} parse error`, e, text);
        throw new Error("Helius parse error");
      }
    };

    const fetchBuyerBalanceSol = async (address: string) => {
      if (!address) return null;
      try {
        const balanceResp = await heliusRpc("getBalance", [address, { commitment: "processed" }]);
        const lamports = Number(balanceResp?.result?.value ?? balanceResp?.result);
        if (Number.isFinite(lamports)) {
          return lamports / LAMPORTS_PER_SOL;
        }
      } catch (err) {
        console.warn("[purchase-property] balance fetch failed", err);
      }
      return null;
    };

    const fetchRate = async (params: Record<string, string>) => {
      const rateQuery = new URLSearchParams(params).toString();
      const rateUrl = `${SWAP_BASE}/rate?${rateQuery}`;
      console.log("[purchase-property] rate URL", rateUrl);
      const resp = await fetch(rateUrl, { method: "GET" });
      const text = await resp.text();
      if (!resp.ok) {
        console.error("[purchase-property] rate error", resp.status, text);
        throw new Error(`Rate API error: ${resp.status}`);
      }
      try {
        const data = JSON.parse(text);
        console.log("[purchase-property] rate response", JSON.stringify(data));
        return data;
      } catch (e) {
        console.error("[purchase-property] rate parse error", e);
        throw new Error("Rate API parse error");
      }
    };

    const extractAmounts = (rate: any) => {
      const amountIn = Number(rate?.amountIn ?? rate?.rate?.amountIn ?? rate?.rate?.amount);
      const amountOut = Number(rate?.amountOut ?? rate?.rate?.amountOut);
      const minAmountOut = Number(rate?.minAmountOut ?? rate?.rate?.minAmountOut);
      return { amountIn, amountOut, minAmountOut };
    };

    const buildSwap = async (fromAmount: string) => {
      const params: Record<string, string> = {
        from: SOL_ADDRESS,
        to: miiworldMint,
        fromAmount,
        slippage: String(slippage),
        payer: buyerPubkey || "",
        txVersion: "v0",
        feeType: "add",
      };
      if (priorityFee !== undefined) params.priorityFee = String(priorityFee);
      if (priorityFee === "auto" && priorityFeeLevel) params.priorityFeeLevel = priorityFeeLevel;
      const query = new URLSearchParams(params).toString();
      const swapUrl = `${SWAP_BASE}/swap?${query}`;
      console.log("[purchase-property] swap URL", swapUrl);
      const resp = await fetch(swapUrl, { method: "GET", headers: { Accept: "application/json", "Content-Type": "application/json" } });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error("[purchase-property] swap error", resp.status, errText);
        throw new Error(`Swap API error: ${resp.status}`);
      }
      const swapData: SwapResponse = await resp.json();
      console.log("[purchase-property] swap response", JSON.stringify(swapData));
      return swapData;
    };

    if (mode === "create") {
      if (!buyerPubkey) throw new Error("buyerPubkey required for create mode");

      // Load listing
      const { data: listing, error: listingError } = await supabase
        .from("real_estate")
        .select("id, lot_number, purchase_price, is_sold")
        .eq("id", listingId)
        .maybeSingle();

      if (listingError || !listing) {
        console.error("[purchase-property] listingError", listingError);
        throw new Error("Listing not found");
      }
      if (listing.is_sold) throw new Error("Listing already sold");

      // Desired tokens out (in UI units)
      const solPrice = Number(listing.purchase_price);
      if (!solPrice || solPrice <= 0) throw new Error("Invalid listing price");

      const slippagePct = Number(slippage);
      if (isNaN(slippagePct) || slippagePct >= 100 || slippagePct < 0) {
        throw new Error("Invalid slippage value");
      }

      const fromAmount = solPrice.toString();
      const requiredSol = solPrice + MIN_SOL_PURCHASE_BUFFER;
      const buyerBalanceSol = await fetchBuyerBalanceSol(buyerPubkey);
      if (buyerBalanceSol !== null && buyerBalanceSol + 1e-9 < requiredSol) {
        throw new Error(`Insufficient SOL balance: need ${requiredSol.toFixed(3)} SOL (price + fees) but wallet has ${buyerBalanceSol.toFixed(3)} SOL`);
      }

      let rateData: any = null;
      try {
        rateData = await fetchRate({
          from: SOL_ADDRESS,
          to: miiworldMint,
          amount: fromAmount,
          amountSide: "from",
          slippage: String(slippage),
          payer: buyerPubkey || "",
          txVersion: "v0",
        });
        console.log("[purchase-property] from-side rate success", { fromAmount, rate: extractAmounts(rateData) });
      } catch (rateErr) {
        console.error("[purchase-property] from-side rate failed", rateErr);
      }

      const swapData = await buildSwap(fromAmount);
      const intentId = crypto.randomUUID();

      return new Response(
        JSON.stringify({
          success: true,
          intentId,
          listingId,
          price: listing.purchase_price,
          txn: swapData.txn,
          rate: swapData.rate ?? rateData,
          txType: swapData.type,
          buyerPubkey,
          mint: miiworldMint,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    // Finalize mode
    if (!purchaseIntentId || !txid) {
      throw new Error("purchaseIntentId and txid required for finalize mode");
    }

    console.log("[purchase-property] mode=finalize", { listingId, userId, txid, purchaseIntentId });

    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

    const waitForConfirmation = async (signature: string) => {
      for (let attempt = 1; attempt <= 12; attempt++) {
        const statusResp = await heliusRpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
        const status = statusResp?.result?.value?.[0];
        console.log(`[purchase-property] signature status attempt ${attempt}`, JSON.stringify(status));

        if (!status) {
          // not found yet
          await sleep(1500);
          continue;
        }
        if (status?.err) throw new Error("Transaction failed on-chain");
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized" || status?.confirmations === null) {
          return;
        }
        await sleep(1500);
      }
      throw new Error("Transaction not found/confirmed after retries");
    };

    const fetchTransactionWithRetry = async (signature: string) => {
      const commitments: ("confirmed" | "finalized")[] = ["confirmed", "finalized"];
      for (const commitment of commitments) {
        for (let attempt = 1; attempt <= 4; attempt++) {
          const txResp = await heliusRpc("getTransaction", [signature, { maxSupportedTransactionVersion: 0, commitment }]);
          const txResult = txResp?.result;
          console.log(`[purchase-property] getTransaction ${commitment} attempt ${attempt} found=${!!txResult}`);
          if (txResult) {
            return txResult;
          }
          await sleep(1200);
        }
      }
      return null;
    };

    // Fetch listing to validate price/state
    const { data: listing, error: listingError } = await supabase
      .from("real_estate")
      .select("id, lot_number, purchase_price, is_sold")
      .eq("id", listingId)
      .maybeSingle();

    if (listingError || !listing) {
      console.error("[purchase-property] listingError finalize", listingError);
      throw new Error("Listing not found");
    }
    if (listing.is_sold) {
      throw new Error("Listing already sold");
    }

    // Wait for confirmation and then fetch transaction
    await waitForConfirmation(txid);

    let txResult: any = await fetchTransactionWithRetry(txid);
    if (!txResult) throw new Error("Transaction result missing after confirmation");
    if (txResult?.meta?.err) {
      throw new Error("Transaction failed on-chain");
    }

    const postTokenBalances = txResult?.meta?.postTokenBalances || [];
    const buyerKey = body.buyerPubkey;
    const tokenBalance = postTokenBalances.find((b: any) => b.mint === miiworldMint);

    if (!tokenBalance) {
      throw new Error("Swap output mint not found in transaction");
    }

    if (buyerKey && tokenBalance.owner && tokenBalance.owner !== buyerKey) {
      throw new Error("Swap output not credited to buyer wallet");
    }

    const uiAmt = tokenBalance?.uiTokenAmount?.uiAmount || 0;
    if (uiAmt <= 0) {
      throw new Error("Swap output zero");
    }

    // Mark listing sold if not already and assign owner
    const { data: updated, error: updateError } = await supabase
      .from("real_estate")
      .update({ is_sold: true, owner_user_id: userId })
      .eq("id", listingId)
      .is("is_sold", false)
      .select();

    if (updateError || !updated || updated.length === 0) {
      throw new Error("Finalize failed: property already sold or update error");
    }

    // Append to user items
    const { data: userRow, error: userError } = await supabase
      .from("users")
      .select("items")
      .eq("id", userId)
      .maybeSingle();

    if (userError) {
      throw new Error("Finalize succeeded but user fetch failed");
    }

    const itemsArr = Array.isArray(userRow?.items) ? userRow.items : [];
    const nextItems = [...itemsArr, listingId];

    const { error: itemsUpdateError } = await supabase
      .from("users")
      .update({ items: nextItems })
      .eq("id", userId);

    if (itemsUpdateError) {
      throw new Error("Finalize succeeded but inventory update failed");
    }

    return new Response(
      JSON.stringify({ success: true, listingId, txid, owner: userId }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: any) {
    console.error("[purchase-property] Error", error);
    return new Response(
      JSON.stringify({ success: false, error: error?.message || "Unknown error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }
});
