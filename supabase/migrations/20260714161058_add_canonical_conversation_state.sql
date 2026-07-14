-- Canonical conversation state machine. Legacy stage fields remain mirrored in
-- metadata during the compatibility window, but conversation_state is the
-- only authoritative state persisted on conversations.
create table if not exists public.conversation_states (
  state text primary key,
  progression_rank smallint not null unique,
  description text not null,
  terminal boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.conversation_states (state, progression_rank, description, terminal)
values
  ('new_lead', 0, 'Conversa sem qualificacao iniciada', false),
  ('welcome_sent', 10, 'Saudacao inicial enviada', false),
  ('test_requested', 20, 'Cliente demonstrou interesse em teste', false),
  ('first_time_check', 25, 'Confirmacao de primeira utilizacao', false),
  ('device_qualification', 30, 'Aparelho sendo qualificado', false),
  ('download_link_sent', 40, 'Instrucao ou link de download enviado', false),
  ('awaiting_download_installation', 45, 'Aguardando download ou instalacao', false),
  ('awaiting_test_activation', 50, 'Aguardando ativacao do teste', false),
  ('price_discovery', 60, 'Descoberta de preco e necessidade', false),
  ('monthly_offer_pending', 62, 'Oferta mensal apresentada', false),
  ('plan_preference', 65, 'Aguardando preferencia de plano', false),
  ('plan_selected', 70, 'Plano definido', false),
  ('pre_sale_recharge_intent', 72, 'Cliente pretende recarregar posteriormente', false),
  ('pix_permission', 75, 'Aguardando permissao para enviar Pix', false),
  ('pix_sent', 80, 'Cobranca Pix enviada', false),
  ('payment_pending', 85, 'Pagamento aguardando confirmacao real', false),
  ('payment_approved', 90, 'Pagamento aprovado pelo backend', false),
  ('code_delivered', 95, 'Codigo entregue apos pagamento', false),
  ('post_sale', 100, 'Atendimento de pos-venda', false),
  ('incompatible_device', 110, 'Aparelho confirmado como incompativel', false),
  ('human_handoff', 120, 'Atendimento assumido por especialista', false)
on conflict (state) do update
set progression_rank = excluded.progression_rank,
    description = excluded.description,
    terminal = excluded.terminal;

create table if not exists public.conversation_state_transitions (
  from_state text not null references public.conversation_states(state),
  to_state text not null references public.conversation_states(state),
  transition_kind text not null check (transition_kind in ('forward', 'alternate_flow', 'renewal', 'human_resume')),
  description text not null,
  created_at timestamptz not null default now(),
  primary key (from_state, to_state)
);

-- Materialize every forward transition as an explicit row. Self-transitions do
-- not need a row because they never change state or create history entries.
insert into public.conversation_state_transitions (from_state, to_state, transition_kind, description)
select source.state, target.state, 'forward', 'Progressao normal do funil UNITV'
from public.conversation_states source
join public.conversation_states target on target.progression_rank > source.progression_rank
where source.state not in ('incompatible_device', 'human_handoff')
on conflict (from_state, to_state) do nothing;

insert into public.conversation_state_transitions (from_state, to_state, transition_kind, description)
values
  ('price_discovery', 'test_requested', 'alternate_flow', 'Cliente preferiu testar antes de comprar'),
  ('price_discovery', 'first_time_check', 'alternate_flow', 'Cliente preferiu testar antes de comprar'),
  ('price_discovery', 'device_qualification', 'alternate_flow', 'Cliente preferiu testar antes de comprar'),
  ('monthly_offer_pending', 'test_requested', 'alternate_flow', 'Cliente preferiu testar antes de comprar'),
  ('monthly_offer_pending', 'device_qualification', 'alternate_flow', 'Cliente preferiu testar antes de comprar'),
  ('plan_preference', 'test_requested', 'alternate_flow', 'Cliente preferiu testar antes de comprar'),
  ('plan_preference', 'device_qualification', 'alternate_flow', 'Cliente preferiu testar antes de comprar'),
  ('plan_selected', 'test_requested', 'alternate_flow', 'Cliente preferiu testar antes de pagar'),
  ('plan_selected', 'device_qualification', 'alternate_flow', 'Cliente preferiu testar antes de pagar'),
  ('pre_sale_recharge_intent', 'test_requested', 'alternate_flow', 'Cliente preferiu testar antes de recarregar'),
  ('pre_sale_recharge_intent', 'device_qualification', 'alternate_flow', 'Cliente trocou a intencao para teste'),
  ('download_link_sent', 'device_qualification', 'alternate_flow', 'Cliente trocou o aparelho'),
  ('awaiting_download_installation', 'device_qualification', 'alternate_flow', 'Cliente trocou o aparelho'),
  ('awaiting_test_activation', 'device_qualification', 'alternate_flow', 'Cliente trocou o aparelho'),
  ('incompatible_device', 'device_qualification', 'alternate_flow', 'Cliente informou outro aparelho'),
  ('incompatible_device', 'download_link_sent', 'alternate_flow', 'Outro aparelho compativel foi confirmado'),
  ('incompatible_device', 'price_discovery', 'alternate_flow', 'Cliente seguiu por outro aparelho'),
  ('incompatible_device', 'monthly_offer_pending', 'alternate_flow', 'Cliente seguiu por outro aparelho'),
  ('incompatible_device', 'plan_preference', 'alternate_flow', 'Cliente seguiu por outro aparelho'),
  ('incompatible_device', 'plan_selected', 'alternate_flow', 'Cliente seguiu por outro aparelho'),
  ('incompatible_device', 'human_handoff', 'alternate_flow', 'Excecao tecnica exige especialista'),
  ('post_sale', 'price_discovery', 'renewal', 'Novo ciclo de renovacao'),
  ('post_sale', 'monthly_offer_pending', 'renewal', 'Novo ciclo de renovacao'),
  ('post_sale', 'plan_preference', 'renewal', 'Novo ciclo de renovacao'),
  ('post_sale', 'plan_selected', 'renewal', 'Novo ciclo de renovacao'),
  ('post_sale', 'pre_sale_recharge_intent', 'renewal', 'Novo ciclo de renovacao')
on conflict (from_state, to_state) do update
set transition_kind = excluded.transition_kind,
    description = excluded.description;

insert into public.conversation_state_transitions (from_state, to_state, transition_kind, description)
select 'human_handoff', state, 'human_resume', 'Especialista liberou retomada contextual do agente'
from public.conversation_states
where state not in ('new_lead', 'welcome_sent', 'human_handoff')
on conflict (from_state, to_state) do nothing;

alter table public.conversations
  add column if not exists conversation_state text,
  add column if not exists conversation_state_version bigint not null default 0,
  add column if not exists conversation_state_changed_at timestamptz;

create or replace function public.normalize_unitv_conversation_state(raw_state text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(trim(coalesce(raw_state, '')))
    when '' then 'new_lead'
    when 'new' then 'new_lead'
    when 'initial_qualification' then 'new_lead'
    when 'welcome_activation' then 'welcome_sent'
    when 'welcome_sent' then 'welcome_sent'
    when 'test_offer' then 'test_requested'
    when 'trial_selection' then 'test_requested'
    when 'test_requested' then 'test_requested'
    when 'first_time_qualification' then 'first_time_check'
    when 'first_time_check' then 'first_time_check'
    when 'device_qualification' then 'device_qualification'
    when 'download_instructions' then 'download_link_sent'
    when 'download_instructions_sent' then 'download_link_sent'
    when 'download_link_sent' then 'download_link_sent'
    when 'download_sent' then 'download_link_sent'
    when 'instalacao' then 'download_link_sent'
    when 'awaiting_installation' then 'awaiting_download_installation'
    when 'download_support' then 'awaiting_download_installation'
    when 'install_support' then 'awaiting_download_installation'
    when 'awaiting_download_installation' then 'awaiting_download_installation'
    when 'awaiting_test_activation' then 'awaiting_test_activation'
    when 'qualified' then 'price_discovery'
    when 'price_discovery' then 'price_discovery'
    when 'special_promo_offered' then 'monthly_offer_pending'
    when 'monthly_offer_pending' then 'monthly_offer_pending'
    when 'payment_choice' then 'plan_preference'
    when 'plan_preference' then 'plan_preference'
    when 'plan_selected' then 'plan_selected'
    when 'pre_sale_commitment_pending_payment' then 'pre_sale_recharge_intent'
    when 'payment_intent_delayed' then 'pre_sale_recharge_intent'
    when 'pre_sale_recharge_intent' then 'pre_sale_recharge_intent'
    when 'checkout' then 'pix_permission'
    when 'pix_permission' then 'pix_permission'
    when 'pix_sent' then 'pix_sent'
    when 'awaiting_payment' then 'payment_pending'
    when 'receipt_under_review' then 'payment_pending'
    when 'payment_pending' then 'payment_pending'
    when 'paid' then 'payment_approved'
    when 'payment_approved' then 'payment_approved'
    when 'code_delivered' then 'code_delivered'
    when 'active' then 'post_sale'
    when 'post_sale' then 'post_sale'
    when 'incompatible_device' then 'incompatible_device'
    when 'human_support' then 'human_handoff'
    when 'human_support_activation' then 'human_handoff'
    when 'human_support_reseller' then 'human_handoff'
    when 'human_handoff' then 'human_handoff'
    else 'new_lead'
  end
$$;

create or replace function public.mirror_unitv_conversation_state(source_metadata jsonb, canonical_state text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(source_metadata, '{}'::jsonb),
                '{lead_profile}',
                case
                  when jsonb_typeof(coalesce(source_metadata, '{}'::jsonb) -> 'lead_profile') = 'object'
                    then coalesce(source_metadata, '{}'::jsonb) -> 'lead_profile'
                  else '{}'::jsonb
                end,
                true
              ),
              '{conversation_state}', to_jsonb(canonical_state), true
            ),
            '{conversation_stage}', to_jsonb(canonical_state), true
          ),
          '{customer_stage}', to_jsonb(canonical_state), true
        ),
        '{lead_profile,stage}', to_jsonb(canonical_state), true
      ),
      '{lead_profile,commercial_stage}', to_jsonb(canonical_state), true
    ),
    '{lead_profile,customer_stage}', to_jsonb(canonical_state), true
  )
$$;

update public.conversations
set conversation_state = public.normalize_unitv_conversation_state(
      coalesce(
        metadata ->> 'conversation_state',
        metadata #>> '{lead_profile,stage}',
        metadata #>> '{lead_profile,commercial_stage}',
        metadata #>> '{lead_profile,customer_stage}',
        metadata #>> '{lead_profile,etapa_atual}',
        metadata ->> 'conversation_stage',
        metadata ->> 'customer_stage'
      )
    ),
    conversation_state_changed_at = coalesce(updated_at, created_at, now());

update public.conversations
set metadata = public.mirror_unitv_conversation_state(metadata, conversation_state);

alter table public.conversations
  alter column conversation_state set default 'new_lead',
  alter column conversation_state set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversations_conversation_state_fkey'
      and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations
      add constraint conversations_conversation_state_fkey
      foreign key (conversation_state) references public.conversation_states(state);
  end if;
end $$;

create index if not exists conversations_conversation_state_idx
  on public.conversations (conversation_state);

create table if not exists public.conversation_state_history (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  previous_state text references public.conversation_states(state),
  next_state text not null references public.conversation_states(state),
  requested_state text not null references public.conversation_states(state),
  event text not null,
  transition_status text not null check (transition_status in ('initial', 'accepted', 'blocked')),
  transition_source text not null default 'application',
  conversation_state_version bigint not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conversation_state_history_conversation_created_idx
  on public.conversation_state_history (conversation_id, created_at desc);
create index if not exists conversation_state_history_blocked_idx
  on public.conversation_state_history (created_at desc)
  where transition_status = 'blocked';

insert into public.conversation_state_history (
  conversation_id, previous_state, next_state, requested_state, event,
  transition_status, transition_source, conversation_state_version, metadata
)
select id, null, conversation_state, conversation_state, 'migration_backfill',
       'initial', 'migration', conversation_state_version, '{}'::jsonb
from public.conversations conversation
where not exists (
  select 1 from public.conversation_state_history history
  where history.conversation_id = conversation.id
);

create or replace function public.enforce_unitv_conversation_state_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  requested text;
  transition_allowed boolean;
  transition_event text;
begin
  -- During the compatibility window, old application versions may still write
  -- only lead_profile.stage. Prefer that requested value, while the new
  -- application writes both it and the canonical column.
  requested := public.normalize_unitv_conversation_state(coalesce(
    nullif(new.metadata ->> 'state_transition_target', ''),
    nullif(new.metadata #>> '{lead_profile,stage}', ''),
    nullif(new.metadata #>> '{lead_profile,commercial_stage}', ''),
    nullif(new.metadata #>> '{lead_profile,customer_stage}', ''),
    nullif(new.metadata #>> '{lead_profile,etapa_atual}', ''),
    nullif(new.metadata ->> 'conversation_stage', ''),
    new.conversation_state
  ));
  transition_event := coalesce(
    nullif(new.metadata ->> 'state_transition_event', ''),
    nullif(new.metadata #>> '{lead_profile,last_customer_intent}', ''),
    nullif(new.metadata ->> 'last_detected_intent', ''),
    'metadata_update'
  );

  if requested = old.conversation_state then
    new.conversation_state := old.conversation_state;
    new.conversation_state_version := old.conversation_state_version;
    new.conversation_state_changed_at := old.conversation_state_changed_at;
    new.metadata := public.mirror_unitv_conversation_state(new.metadata, old.conversation_state);
    return new;
  end if;

  select exists (
    select 1 from public.conversation_state_transitions transition
    where transition.from_state = old.conversation_state
      and transition.to_state = requested
  ) into transition_allowed;

  if transition_allowed then
    new.conversation_state := requested;
    new.conversation_state_version := old.conversation_state_version + 1;
    new.conversation_state_changed_at := now();
    new.metadata := public.mirror_unitv_conversation_state(new.metadata, requested);

    insert into public.conversation_state_history (
      conversation_id, previous_state, next_state, requested_state, event,
      transition_status, transition_source, conversation_state_version, metadata
    ) values (
      old.id, old.conversation_state, requested, requested, transition_event,
      'accepted', 'database_guard', new.conversation_state_version,
      jsonb_build_object('legacy_state_mirror', true)
    );
  else
    new.conversation_state := old.conversation_state;
    new.conversation_state_version := old.conversation_state_version;
    new.conversation_state_changed_at := old.conversation_state_changed_at;
    new.metadata := public.mirror_unitv_conversation_state(new.metadata, old.conversation_state);

    insert into public.conversation_state_history (
      conversation_id, previous_state, next_state, requested_state, event,
      transition_status, transition_source, conversation_state_version, metadata
    ) values (
      old.id, old.conversation_state, old.conversation_state, requested, transition_event,
      'blocked', 'database_guard', old.conversation_state_version,
      jsonb_build_object('reason', 'transition_not_allowed')
    );
  end if;

  return new;
end
$$;

drop trigger if exists conversations_enforce_canonical_state on public.conversations;
create trigger conversations_enforce_canonical_state
before update of conversation_state, metadata on public.conversations
for each row execute function public.enforce_unitv_conversation_state_transition();

create or replace function public.record_initial_unitv_conversation_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.conversation_state_history (
    conversation_id, previous_state, next_state, requested_state, event,
    transition_status, transition_source, conversation_state_version, metadata
  ) values (
    new.id, null, new.conversation_state, new.conversation_state, 'conversation_created',
    'initial', 'database_guard', new.conversation_state_version, '{}'::jsonb
  );
  return new;
end
$$;

drop trigger if exists conversations_record_initial_state on public.conversations;
create trigger conversations_record_initial_state
after insert on public.conversations
for each row execute function public.record_initial_unitv_conversation_state();

alter table public.conversation_states enable row level security;
alter table public.conversation_state_transitions enable row level security;
alter table public.conversation_state_history enable row level security;

revoke all on table public.conversation_states from anon, authenticated;
revoke all on table public.conversation_state_transitions from anon, authenticated;
revoke all on table public.conversation_state_history from anon, authenticated;
revoke execute on function public.normalize_unitv_conversation_state(text) from public, anon, authenticated;
revoke execute on function public.mirror_unitv_conversation_state(jsonb, text) from public, anon, authenticated;
revoke execute on function public.enforce_unitv_conversation_state_transition() from public, anon, authenticated;
revoke execute on function public.record_initial_unitv_conversation_state() from public, anon, authenticated;
grant execute on function public.normalize_unitv_conversation_state(text) to service_role;
grant execute on function public.mirror_unitv_conversation_state(jsonb, text) to service_role;
grant execute on function public.enforce_unitv_conversation_state_transition() to service_role;
grant execute on function public.record_initial_unitv_conversation_state() to service_role;

drop policy if exists "Service role can read conversation states" on public.conversation_states;
create policy "Service role can read conversation states"
  on public.conversation_states for select to service_role using (true);

drop policy if exists "Service role can read conversation state transitions" on public.conversation_state_transitions;
create policy "Service role can read conversation state transitions"
  on public.conversation_state_transitions for select to service_role using (true);

drop policy if exists "Service role can manage conversation state history" on public.conversation_state_history;
create policy "Service role can manage conversation state history"
  on public.conversation_state_history for all to service_role using (true) with check (true);
