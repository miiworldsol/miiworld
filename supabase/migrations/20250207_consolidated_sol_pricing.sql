-- Consolidated SOL pricing updates for real_estate listings
-- Low-income: 0.01 SOL (test value)
-- Medium: 2 SOL
-- High/Mansion: 4 SOL

update public.real_estate set purchase_price = 0.01 where tier = 'low';
update public.real_estate set purchase_price = 2 where tier = 'medium';
update public.real_estate set purchase_price = 4 where tier = 'high';
