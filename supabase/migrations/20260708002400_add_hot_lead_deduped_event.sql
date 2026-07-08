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
      'hot_lead_alert_deduped',
      'hot_lead_alert_sent',
      'hot_lead_alert_failed'
    )
  );
