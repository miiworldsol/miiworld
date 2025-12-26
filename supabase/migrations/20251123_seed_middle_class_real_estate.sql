-- Seed middle-class properties (lots 101-106)
insert into public.real_estate (lot_number, tier, purchase_price, rent_yield, is_sold)
select lot, 'medium', 2::numeric, 9500::numeric, false
from generate_series(101, 106) as lot
on conflict do nothing;
