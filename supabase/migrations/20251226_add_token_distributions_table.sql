-- Track every treasury distribution with Solscan reference
create table if not exists public.token_distributions (
  id uuid primary key default gen_random_uuid(),
  owner_wallet text not null,
  listing_ids uuid[] not null,
  token_amount numeric(36, 6) not null,
  signature text not null,
  solscan_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_token_distributions_owner on public.token_distributions(owner_wallet);
create index if not exists idx_token_distributions_signature on public.token_distributions(signature);
