-- Seed upper-class properties (lots 201-206)
insert into public.real_estate (lot_number, tier, purchase_price, rent_yield, is_sold)
select lot, 'high', 4::numeric, 30000::numeric, false
from generate_series(201, 206) as lot
on conflict do nothing;
