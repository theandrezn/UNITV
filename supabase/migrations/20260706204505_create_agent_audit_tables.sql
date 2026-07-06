create table if not exists public.agent_event_logs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete set null,
  customer_phone text,
  event_type text not null check (
    event_type in (
      'customer_message',
      'bot_message',
      'specialist_message',
      'ai_called',
      'local_rule_used',
      'human_intervention',
      'repetition_blocked',
      'followup_sent',
      'price_asked',
      'download_asked',
      'installation_asked',
      'test_asked',
      'pix_asked',
      'plan_selected',
      'proof_sent',
      'payment_confirmed',
      'converted',
      'support_requested',
      'customer_abandoned',
      'install_stuck',
      'pix_requested_not_paid',
      'response_sanitized',
      'debug_blocked',
      'handoff_started',
      'handoff_resumed'
    )
  ),
  event_source text not null check (
    event_source in (
      'webhook',
      'chat_agent',
      'followup_job',
      'payment_webhook',
      'specialist_training',
      'audit_job',
      'system'
    )
  ),
  intent text,
  stage text,
  objection text,
  device text,
  plan_interest text,
  message_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_event_logs_conversation_id_idx on public.agent_event_logs (conversation_id);
create index if not exists agent_event_logs_customer_phone_idx on public.agent_event_logs (customer_phone);
create index if not exists agent_event_logs_event_type_idx on public.agent_event_logs (event_type);
create index if not exists agent_event_logs_event_source_idx on public.agent_event_logs (event_source);
create index if not exists agent_event_logs_created_at_idx on public.agent_event_logs (created_at);
create index if not exists agent_event_logs_intent_stage_idx on public.agent_event_logs (intent, stage);

alter table public.agent_event_logs enable row level security;
revoke all on table public.agent_event_logs from anon, authenticated;
drop policy if exists "Service role can manage agent event logs" on public.agent_event_logs;
create policy "Service role can manage agent event logs"
  on public.agent_event_logs
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.agent_daily_audits (
  id uuid primary key default gen_random_uuid(),
  audit_date date not null,
  timezone text not null default 'America/Sao_Paulo',
  period_start timestamptz not null,
  period_end timestamptz not null,
  total_conversations integer not null default 0,
  total_customer_messages integer not null default 0,
  total_bot_messages integer not null default 0,
  total_specialist_messages integer not null default 0,
  total_ai_calls integer not null default 0,
  total_local_rule_responses integer not null default 0,
  total_human_interventions integer not null default 0,
  total_repetition_blocks integer not null default 0,
  total_followups_sent integer not null default 0,
  asked_price_count integer not null default 0,
  asked_download_count integer not null default 0,
  asked_installation_count integer not null default 0,
  asked_test_count integer not null default 0,
  asked_pix_count integer not null default 0,
  selected_plan_count integer not null default 0,
  sent_proof_count integer not null default 0,
  payment_confirmed_count integer not null default 0,
  converted_count integer not null default 0,
  abandoned_after_price_count integer not null default 0,
  abandoned_after_download_count integer not null default 0,
  abandoned_after_pix_count integer not null default 0,
  stuck_installation_count integer not null default 0,
  support_requested_count integer not null default 0,
  pix_requested_not_paid_count integer not null default 0,
  objections_summary jsonb not null default '{}'::jsonb,
  devices_summary jsonb not null default '{}'::jsonb,
  stages_summary jsonb not null default '{}'::jsonb,
  ai_intents_summary jsonb not null default '{}'::jsonb,
  human_intervention_reasons jsonb not null default '{}'::jsonb,
  top_problem_conversations jsonb not null default '[]'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  short_report text,
  full_report text,
  sent_to_admin boolean not null default false,
  sent_to_admin_at timestamptz,
  admin_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (audit_date, timezone)
);

create index if not exists agent_daily_audits_audit_date_idx on public.agent_daily_audits (audit_date);
create index if not exists agent_daily_audits_sent_to_admin_idx on public.agent_daily_audits (sent_to_admin);

drop trigger if exists agent_daily_audits_handle_updated_at on public.agent_daily_audits;
create trigger agent_daily_audits_handle_updated_at
before update on public.agent_daily_audits
for each row execute function public.handle_updated_at();

alter table public.agent_daily_audits enable row level security;
revoke all on table public.agent_daily_audits from anon, authenticated;
drop policy if exists "Service role can manage agent daily audits" on public.agent_daily_audits;
create policy "Service role can manage agent daily audits"
  on public.agent_daily_audits
  for all
  to service_role
  using (true)
  with check (true);
