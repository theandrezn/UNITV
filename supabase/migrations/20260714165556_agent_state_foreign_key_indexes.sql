-- Cover foreign keys used by the unified state and shadow decision reports.
create index if not exists agent_shadow_decisions_active_next_state_idx
  on public.agent_shadow_decisions (active_next_state);
create index if not exists agent_shadow_decisions_shadow_next_state_idx
  on public.agent_shadow_decisions (shadow_next_state);

create index if not exists conversation_state_history_previous_state_idx
  on public.conversation_state_history (previous_state);
create index if not exists conversation_state_history_next_state_idx
  on public.conversation_state_history (next_state);
create index if not exists conversation_state_history_requested_state_idx
  on public.conversation_state_history (requested_state);
create index if not exists conversation_state_transitions_to_state_idx
  on public.conversation_state_transitions (to_state);

create index if not exists specialist_training_examples_customer_id_idx
  on public.specialist_training_examples (customer_id);
