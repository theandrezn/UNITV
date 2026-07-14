begin;

do $$
declare
  invalid_conversations bigint;
  divergent_mirrors bigint;
begin
  select count(*) into invalid_conversations
  from public.conversations conversation
  left join public.conversation_states state_definition
    on state_definition.state = conversation.conversation_state
  where conversation.conversation_state is null
     or state_definition.state is null;

  if invalid_conversations <> 0 then
    raise exception 'canonical_state_invalid_conversations=%', invalid_conversations;
  end if;

  select count(*) into divergent_mirrors
  from public.conversations
  where coalesce(metadata ->> 'conversation_state', '') <> conversation_state
     or coalesce(metadata #>> '{lead_profile,stage}', '') <> conversation_state
     or coalesce(metadata #>> '{lead_profile,commercial_stage}', '') <> conversation_state
     or coalesce(metadata ->> 'conversation_stage', '') <> conversation_state;

  if divergent_mirrors <> 0 then
    raise exception 'canonical_state_divergent_mirrors=%', divergent_mirrors;
  end if;
end
$$;

insert into public.conversations (
  id,
  channel,
  external_conversation_id,
  status,
  metadata,
  conversation_state,
  conversation_state_changed_at
) values (
  '00000000-0000-4000-8000-000000000042',
  'manual',
  'codex-canonical-state-rollback-test',
  'open',
  '{"lead_profile":{"stage":"new_lead"}}'::jsonb,
  'new_lead',
  now()
);

update public.conversations
set conversation_state = 'payment_pending',
    metadata = jsonb_build_object(
      'state_transition_event', 'verification_forward_transition',
      'lead_profile', jsonb_build_object('stage', 'payment_pending')
    )
where id = '00000000-0000-4000-8000-000000000042';

update public.conversations
set conversation_state = 'welcome_sent',
    metadata = jsonb_build_object(
      'state_transition_event', 'verification_blocked_regression',
      'lead_profile', jsonb_build_object('stage', 'welcome_sent')
    )
where id = '00000000-0000-4000-8000-000000000042';

do $$
declare
  final_state text;
  final_version bigint;
  accepted_count bigint;
  blocked_count bigint;
begin
  select conversation_state, conversation_state_version
  into final_state, final_version
  from public.conversations
  where id = '00000000-0000-4000-8000-000000000042';

  select count(*) filter (where transition_status = 'accepted'),
         count(*) filter (where transition_status = 'blocked')
  into accepted_count, blocked_count
  from public.conversation_state_history
  where conversation_id = '00000000-0000-4000-8000-000000000042';

  if final_state <> 'payment_pending' then
    raise exception 'blocked regression changed final state to %', final_state;
  end if;
  if final_version <> 1 then
    raise exception 'unexpected state version %', final_version;
  end if;
  if accepted_count <> 1 or blocked_count <> 1 then
    raise exception 'unexpected history accepted=% blocked=%', accepted_count, blocked_count;
  end if;
end
$$;

select
  (select count(*) from public.conversation_states) as canonical_states,
  (select count(*) from public.conversation_state_transitions) as allowed_transitions,
  (select count(*) from public.conversation_state_history) as persisted_history_entries,
  'payment_pending_regression_blocked' as verification;

rollback;
