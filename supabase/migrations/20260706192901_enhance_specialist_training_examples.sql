alter table if exists public.specialist_training_examples
  add column if not exists source text not null default 'whatsapp',
  add column if not exists conversation_excerpt text,
  add column if not exists inferred_customer_state text,
  add column if not exists inferred_specialist_action text,
  add column if not exists why_specialist_intervened text,
  add column if not exists style_notes text,
  add column if not exists should_copy_style boolean not null default true,
  add column if not exists human_intervention_detected boolean not null default true,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_used_at timestamptz;

alter table if exists public.specialist_training_examples
  drop constraint if exists specialist_training_examples_success_signal_check;
alter table if exists public.specialist_training_examples
  add constraint specialist_training_examples_success_signal_check
  check (success_signal is null or success_signal in ('unknown', 'positive', 'neutral', 'negative'));

create index if not exists specialist_training_examples_relevance_idx
  on public.specialist_training_examples
  (inferred_intent, inferred_stage, success_signal, created_at desc)
  where should_copy_style = true;

create index if not exists specialist_training_examples_action_idx
  on public.specialist_training_examples
  (inferred_specialist_action, why_specialist_intervened, created_at desc);

alter table if exists public.specialist_training_examples enable row level security;
drop policy if exists "Service role can manage specialist training examples" on public.specialist_training_examples;
create policy "Service role can manage specialist training examples"
  on public.specialist_training_examples
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.specialist_training_examples from anon, authenticated;
