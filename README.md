# Mii World Real Estate Distribution Stack

This repository exposes the on-chain infrastructure that powers Mii World's property sales and automated rent distributions. Only the production-critical Supabase Edge Functions and Postgres migrations are included so the community can verify that the treasury logic is real and auditable.

## Overview

- **`supabase/functions/purchase-property`** – builds and validates swaps for property purchases. It quotes the SOL→$MIIWORLD swap via Solana Tracker, prepares the Phantom-ready transaction, and finalizes once the buyer signature lands on-chain. After confirmation it marks the lot as sold and attaches the property to the user's inventory.
- **`supabase/functions/distribute-treasury`** – runs on a 5‑minute cron. It loads every sold property, aggregates the advertised rent yields, pulls MI token balances from the treasury wallet, and sends the exact rent amounts to each owner's wallet. Every payout is persisted with its Solscan link in `token_distributions` for proof.
- **`supabase/migrations`** – defines the entire real-estate schema, seeding of low/medium/high tier lots, SOL pricing updates, and the token distribution ledger table.

## Real Estate Flow

1. **Listings** – The `real_estate` table is pre-seeded with 18 lots across three tiers (low, medium, high). Each tier advertises a specific rent yield (3,000 / 9,500 / 30,000 tokens per drop) and a SOL purchase price (0.01 / 2 / 4 SOL).
2. **Purchase** – When a player clicks *Buy*
   - The client calls `purchase-property` with `mode=create`.
   - The function verifies price + slippage, requests a Solana Tracker swap, and returns the encoded transaction + swap intent.
   - The wallet signs and broadcasts the transaction.
   - `purchase-property` is called again with `mode=finalize`; it waits for confirmation via Helius RPC, confirms the MI mint lands in the buyer's ATA, then marks the property as sold and appends the lot to the player's inventory.
3. **Distribution** – `distribute-treasury` is invoked every five minutes via cron.
   - It reads the Supabase secrets `treasury_wallet`, `miiworld_token`, and `helius_key`.
   - Aggregates all sold properties and sums each owner's rent yield.
   - Sends the exact rent to the owner's associated token account, creating ATAs if needed. Supports both Token Program v1 and Token-2022 mints.
   - Logs each payout into `token_distributions` with a Solscan URL.

## Token Supply Narrative

Our $MIIWORLD token is the lifeblood of the in-game economy and is modeled after a real governmental currency:

- Citizens acquire property by swapping SOL for $MIIWORLD via `purchase-property`. Those swaps stream new liquidity directly into the treasury.
- Holders can cycle their proceeds into **Mii World Government Bonds**, earning 5% daily on their staked $MIIWORLD.
- Alternatively, they can reinvest in more properties, compounding rent yields, or sell their supply back into the open market. This creates natural demand while rewarding long-term builders.

## Deployment Notes

1. **Secrets** (`supabase secrets set`):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `helius_key`
   - `miiworld_token` (mint address)
   - `treasury_wallet` (private key JSON/base58/base64)
2. **Migrations**: `supabase db push` to create the tables and seeds.
3. **Functions**: `supabase functions deploy purchase-property distribute-treasury`.
4. **Cron**: Schedule `distribute-treasury` every five minutes.

All commits in this repo are authored under the neutral contributor handle **MIIWORLDDEV** to avoid exposing personal workstation details.
