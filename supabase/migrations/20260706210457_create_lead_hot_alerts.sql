alter table public.agent_event_logs
  drop constraint if exists agent_event_logs_event_type_check;

alter table public.agent_event_logs
  add constraint agent_event_logs_event_type_check
  check (
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
      'handoff_resumed',
      'hot_lead_detected',
      'hot_lead_alert_sent',
      'hot_lead_alert_failed'
    )
  );

create table if not exists public.lead_hot_alerts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  customer_phone text not null,
  customer_name text,
  alert_type text not null check (
    alert_type in (
      'pix_requested',
      'plan_selected',
      'wants_to_pay',
      'downloaded_app',
      'proof_sent',
      'test_requested',
      'installation_stuck',
      'price_asked_multiple_times',
      'screens_question',
      'human_support_needed',
      'hot_lead_abandoned',
      'payment_pending',
      'manual_review_needed'
    )
  ),
  lead_temperature text not null check (lead_temperature in ('frio', 'morno', 'quente', 'muito_quente')),
  trigger_message text,
  trigger_intent text,
  trigger_stage text,
  plan_interest text,
  device text,
  main_objection text,
  last_customer_message text,
  last_bot_message text,
  next_best_action text,
  admin_message text,
  sent_to_admin boolean not null default false,
  sent_to_admin_at timestamptz,
  admin_message_id text,
  dedupe_key text not null,
  send_attempts integer not null default 0,
  last_send_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dedupe_key)
);

create index if not exists lead_hot_alerts_conversation_id_idx on public.lead_hot_alerts (conversation_id);
create index if not exists lead_hot_alerts_customer_phone_idx on public.lead_hot_alerts (customer_phone);
create index if not exists lead_hot_alerts_alert_type_idx on public.lead_hot_alerts (alert_type);
create index if not exists lead_hot_alerts_temperature_idx on public.lead_hot_alerts (lead_temperature);
create index if not exists lead_hot_alerts_sent_to_admin_idx on public.lead_hot_alerts (sent_to_admin);
create index if not exists lead_hot_alerts_created_at_idx on public.lead_hot_alerts (created_at);

drop trigger if exists lead_hot_alerts_handle_updated_at on public.lead_hot_alerts;
create trigger lead_hot_alerts_handle_updated_at
before update on public.lead_hot_alerts
for each row execute function public.handle_updated_at();

alter table public.lead_hot_alerts enable row level security;
revoke all on table public.lead_hot_alerts from anon, authenticated;
drop policy if exists "Service role can manage lead hot alerts" on public.lead_hot_alerts;
create policy "Service role can manage lead hot alerts"
  on public.lead_hot_alerts
  for all
  to service_role
  using (true)
  with check (true);
