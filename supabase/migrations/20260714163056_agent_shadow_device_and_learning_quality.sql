-- Shadow evaluation, capability-based device context and evidence-gated learning.
alter table public.conversations
  add column if not exists device_brand text,
  add column if not exists device_type text,
  add column if not exists operating_system text,
  add column if not exists has_play_store boolean,
  add column if not exists android_confirmed boolean,
  add column if not exists compatibility_status text,
  add column if not exists installation_attempt_status text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversations_compatibility_status_check'
      and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations add constraint conversations_compatibility_status_check
      check (compatibility_status is null or compatibility_status in ('unknown', 'needs_capability_check', 'compatible', 'incompatible'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversations_installation_attempt_status_check'
      and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations add constraint conversations_installation_attempt_status_check
      check (installation_attempt_status is null or installation_attempt_status in ('not_started', 'instructions_sent', 'downloaded', 'installed', 'failed'));
  end if;
end $$;

create index if not exists conversations_compatibility_attention_idx
  on public.conversations (compatibility_status, updated_at desc)
  where compatibility_status in ('unknown', 'needs_capability_check', 'incompatible');

create table if not exists public.agent_shadow_decisions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  message_id text,
  decision_key text not null unique,
  channel text not null check (channel in ('reply', 'followup')),
  active_action text not null check (active_action in ('reply', 'silent', 'wait', 'handoff', 'backend_action')),
  shadow_action text not null check (shadow_action in ('reply', 'silent', 'wait', 'handoff', 'backend_action')),
  active_next_state text references public.conversation_states(state),
  shadow_next_state text references public.conversation_states(state),
  active_reason text,
  shadow_reason text,
  divergence_types jsonb not null default '[]'::jsonb,
  comparison_status text not null default 'pending_review'
    check (comparison_status in ('match', 'divergent', 'pending_review', 'approved', 'rejected')),
  would_send boolean not null default false,
  blocked_before_ai boolean not null default false,
  ai_call_count integer not null default 0 check (ai_call_count >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  metadata jsonb not null default '{}'::jsonb,
  shadow_started_at timestamptz not null default now(),
  shadow_expires_at timestamptz not null default (now() + interval '48 hours'),
  last_evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_shadow_decisions_review_idx
  on public.agent_shadow_decisions (comparison_status, created_at desc);
create index if not exists agent_shadow_decisions_conversation_idx
  on public.agent_shadow_decisions (conversation_id, created_at desc);
create index if not exists agent_shadow_decisions_followup_window_idx
  on public.agent_shadow_decisions (shadow_expires_at, created_at desc)
  where channel = 'followup';

alter table public.agent_shadow_decisions enable row level security;
revoke all on table public.agent_shadow_decisions from anon, authenticated;
grant select, insert, update, delete on table public.agent_shadow_decisions to service_role;
drop policy if exists "Service role can manage shadow decisions" on public.agent_shadow_decisions;
create policy "Service role can manage shadow decisions"
  on public.agent_shadow_decisions for all to service_role using (true) with check (true);

alter table public.specialist_training_examples
  add column if not exists quality_gate_status text not null default 'candidate',
  add column if not exists outcome_evidence jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'specialist_training_examples_quality_gate_status_check'
      and conrelid = 'public.specialist_training_examples'::regclass
  ) then
    alter table public.specialist_training_examples add constraint specialist_training_examples_quality_gate_status_check
      check (quality_gate_status in ('candidate', 'qualified', 'rejected'));
  end if;
end $$;

update public.specialist_training_examples
set quality_gate_status = case
  when review_status = 'rejected' or outcome_status = 'negative' then 'rejected'
  when review_status = 'approved' and outcome_status = 'positive' then 'qualified'
  else 'candidate'
end;

alter table public.agent_learning_memories
  drop constraint if exists agent_learning_memories_status_check;
alter table public.agent_learning_memories
  add constraint agent_learning_memories_status_check
  check (status in ('candidate', 'active', 'superseded', 'rejected'));

revoke all on table public.agent_shadow_decisions from public;
