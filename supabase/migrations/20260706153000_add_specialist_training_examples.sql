create table if not exists public.specialist_training_examples (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  customer_phone text,
  customer_last_message text,
  bot_previous_message text,
  specialist_message text not null,
  inferred_intent text,
  inferred_stage text,
  inferred_objection text,
  reason text not null check (reason in ('human_takeover', 'correction', 'sales_style', 'support_resolution')),
  bot_response_was_overridden boolean not null default false,
  used_count integer not null default 0,
  success_signal text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists specialist_training_examples_conversation_idx
  on public.specialist_training_examples(conversation_id, created_at desc);

create index if not exists specialist_training_examples_lookup_idx
  on public.specialist_training_examples(inferred_intent, inferred_stage, inferred_objection, created_at desc);

alter table public.specialist_training_examples enable row level security;

drop policy if exists "Service role can manage specialist training examples" on public.specialist_training_examples;
create policy "Service role can manage specialist training examples"
  on public.specialist_training_examples
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
