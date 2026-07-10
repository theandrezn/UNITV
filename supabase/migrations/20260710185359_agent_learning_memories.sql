create table if not exists public.agent_learning_memories (
  id uuid primary key default gen_random_uuid(),
  learning_date date not null,
  timezone text not null default 'America/Sao_Paulo',
  learning_type text not null default 'daily_specialist_pattern',
  intent text,
  stage text,
  rule text not null,
  style_directive text not null,
  avoid jsonb not null default '[]'::jsonb,
  evidence_count integer not null default 0,
  confidence numeric(4,3) not null default 0.500,
  source_example_ids uuid[] not null default '{}',
  rule_hash text not null unique,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (learning_type in ('daily_specialist_pattern')),
  check (status in ('active', 'superseded', 'rejected')),
  check (confidence >= 0 and confidence <= 1)
);

create index if not exists agent_learning_memories_relevance_idx
  on public.agent_learning_memories (status, intent, stage, learning_date desc)
  where status = 'active';

alter table public.agent_learning_memories enable row level security;
revoke all on table public.agent_learning_memories from anon, authenticated;
drop policy if exists "Service role can manage agent learning memories" on public.agent_learning_memories;
create policy "Service role can manage agent learning memories"
  on public.agent_learning_memories
  for all
  to service_role
  using (true)
  with check (true);

alter table public.agent_daily_audits
  add column if not exists learning_memories_created_count integer not null default 0,
  add column if not exists learning_summary jsonb not null default '{}'::jsonb;
