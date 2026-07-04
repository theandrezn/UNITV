insert into public.products (name, slug, status)
values ('UniTV', 'unitv', 'active')
on conflict (slug) do update
set name = excluded.name,
    status = excluded.status,
    updated_at = now();

insert into public.plans (product_id, name, slug, duration_days, price_cents, currency, status)
select products.id, seed_plans.name, seed_plans.slug, seed_plans.duration_days, seed_plans.price_cents, 'BRL', 'active'
from public.products
cross join (
  values
    ('Mensal', 'mensal', 30, 2500),
    ('3 meses', 'trimestral', 90, 7000),
    ('6 meses', 'semestral', 180, 12000),
    ('Anual', 'anual', 365, 20000),
    ('Teste gratis', 'teste', 3, 0)
) as seed_plans(name, slug, duration_days, price_cents)
where products.slug = 'unitv'
on conflict (product_id, slug) do update
set name = excluded.name,
    duration_days = excluded.duration_days,
    price_cents = excluded.price_cents,
    status = excluded.status,
    updated_at = now();
