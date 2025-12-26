-- Create real_estate table to track houses/lots/ownership
create table if not exists public.real_estate (
  id uuid primary key default gen_random_uuid(),
  lot_number integer not null,
  tier text not null check (tier in ('low','medium','high')),
  purchase_price numeric(18,2) not null,
  is_sold boolean not null default false,
  owner_user_id uuid references public.users(id) on delete set null,
  rent_yield numeric(18,2) not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_real_estate_tier on public.real_estate(tier);
create index if not exists idx_real_estate_is_sold on public.real_estate(is_sold);
create index if not exists idx_real_estate_owner on public.real_estate(owner_user_id);

insert into public.real_estate (lot_number, tier, purchase_price, rent_yield, is_sold)
select lot, 'low', 0.01::numeric, 3000::numeric, false
from generate_series(1, 6) as lot;
