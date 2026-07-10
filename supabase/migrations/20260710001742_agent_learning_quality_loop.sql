alter table public.agent_event_logs
  drop constraint if exists agent_event_logs_event_type_check;

alter table public.agent_event_logs
  add constraint agent_event_logs_event_type_check
  check (
    event_type in (
      'customer_message', 'bot_message', 'specialist_message', 'ai_called', 'local_rule_used',
      'human_intervention', 'repetition_blocked', 'followup_scheduled', 'followup_sent',
      'greeting_blocked', 'followup_cancelled', 'price_asked', 'download_asked',
      'installation_asked', 'test_asked', 'pix_asked', 'plan_selected', 'proof_sent',
      'payment_confirmed', 'converted', 'support_requested', 'customer_abandoned',
      'install_stuck', 'pix_requested_not_paid', 'response_sanitized', 'debug_blocked',
      'handoff_started', 'handoff_resumed', 'hot_lead_detected', 'hot_lead_alert_deduped',
      'hot_lead_alert_sent', 'hot_lead_alert_failed'
    )
  );

alter table public.agent_daily_audits
  add column if not exists sales_concluded_count integer not null default 0,
  add column if not exists customer_abandoned_count integer not null default 0,
  add column if not exists human_takeover_count integer not null default 0,
  add column if not exists repeated_question_count integer not null default 0,
  add column if not exists greeting_blocked_count integer not null default 0,
  add column if not exists download_stuck_count integer not null default 0,
  add column if not exists followup_cancelled_count integer not null default 0,
  add column if not exists approved_specialist_examples_count integer not null default 0,
  add column if not exists pending_specialist_examples_count integer not null default 0,
  add column if not exists lead_loss_summary jsonb not null default '{}'::jsonb;

alter table public.specialist_training_examples
  add column if not exists review_status text not null default 'pending_review',
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text,
  add column if not exists approval_reason text,
  add column if not exists outcome_status text not null default 'pending',
  add column if not exists outcome_observed_at timestamptz,
  add column if not exists outcome_notes text;

alter table public.specialist_training_examples
  drop constraint if exists specialist_training_examples_review_status_check;
alter table public.specialist_training_examples
  add constraint specialist_training_examples_review_status_check
  check (review_status in ('pending_review', 'approved', 'rejected'));

alter table public.specialist_training_examples
  drop constraint if exists specialist_training_examples_outcome_status_check;
alter table public.specialist_training_examples
  add constraint specialist_training_examples_outcome_status_check
  check (outcome_status in ('pending', 'positive', 'neutral', 'negative'));

-- Existing positive examples remain usable, while all future human examples require review.
update public.specialist_training_examples
set
  review_status = 'approved',
  reviewed_at = coalesce(reviewed_at, updated_at, created_at),
  reviewed_by = coalesce(reviewed_by, 'legacy_quality_backfill'),
  approval_reason = coalesce(approval_reason, 'legacy_positive_example'),
  outcome_status = case when success_signal = 'positive' then 'positive' else 'neutral' end,
  outcome_observed_at = coalesce(outcome_observed_at, updated_at, created_at)
where review_status = 'pending_review'
  and success_signal in ('positive', 'neutral');

create index if not exists specialist_training_examples_review_outcome_idx
  on public.specialist_training_examples (review_status, outcome_status, inferred_intent, inferred_stage, created_at desc)
  where should_copy_style = true;
