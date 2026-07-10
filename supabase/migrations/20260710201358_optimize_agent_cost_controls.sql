-- Move time-sensitive agent work out of unindexed JSON metadata. This keeps the
-- one-minute worker focused on conversations that can actually require action.
alter table public.conversations
  add column if not exists followup_due_at timestamptz,
  add column if not exists response_due_at timestamptz;

update public.conversations
set followup_due_at = (metadata ->> 'followup_due_at')::timestamptz
where followup_due_at is null
  and coalesce(metadata ->> 'followup_due_at', '') ~ '^\d{4}-\d{2}-\d{2}T';

update public.conversations
set response_due_at = (metadata ->> 'response_due_at')::timestamptz
where response_due_at is null
  and coalesce(metadata ->> 'response_due_at', '') ~ '^\d{4}-\d{2}-\d{2}T';

create index if not exists conversations_open_followup_due_idx
  on public.conversations (followup_due_at)
  where channel = 'whatsapp' and status = 'open' and followup_due_at is not null;

create index if not exists conversations_open_response_due_idx
  on public.conversations (response_due_at)
  where channel = 'whatsapp' and status = 'open' and response_due_at is not null;

-- A source example is marked only after a successful synthesis. If its review
-- changes later, source_updated_at makes it eligible for learning again.
create table if not exists public.agent_learning_example_progress (
  example_id uuid primary key references public.specialist_training_examples(id) on delete cascade,
  source_updated_at timestamptz not null,
  processed_at timestamptz not null default now(),
  result text not null default 'synthesized' check (result in ('synthesized', 'no_safe_directive')),
  memories_created_count integer not null default 0 check (memories_created_count >= 0),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists agent_learning_example_progress_processed_idx
  on public.agent_learning_example_progress (processed_at desc);

alter table public.agent_learning_example_progress enable row level security;
revoke all on table public.agent_learning_example_progress from anon, authenticated;
drop policy if exists "Service role can manage agent learning example progress" on public.agent_learning_example_progress;
create policy "Service role can manage agent learning example progress"
  on public.agent_learning_example_progress
  for all
  to service_role
  using (true)
  with check (true);
