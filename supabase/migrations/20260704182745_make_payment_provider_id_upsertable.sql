drop index if exists public.payments_provider_payment_id_unique_idx;

alter table public.payments
  drop constraint if exists payments_provider_payment_id_unique;

alter table public.payments
  add constraint payments_provider_payment_id_unique
  unique (provider, provider_payment_id);
