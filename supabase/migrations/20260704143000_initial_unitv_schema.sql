create extension if not exists pgcrypto;

create sequence if not exists public.order_number_seq;

create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.generate_order_number()
returns text
language plpgsql
as $$
declare
  next_value bigint;
begin
  next_value := nextval('public.order_number_seq');
  return 'UTV-' || to_char(now(), 'YYYYMMDD') || '-' || lpad((next_value % 1000000)::text, 6, '0');
end;
$$;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text not null,
  email text,
  external_channel text,
  external_user_id text,
  status text not null default 'active' check (status in ('active', 'inactive', 'blocked')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists customers_phone_unique_idx on public.customers (phone);
create index if not exists customers_email_idx on public.customers (email);
create index if not exists customers_external_channel_user_idx on public.customers (external_channel, external_user_id);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  name text not null,
  slug text not null,
  duration_days integer check (duration_days is null or duration_days > 0),
  price_cents integer not null check (price_cents >= 0),
  currency text not null default 'BRL',
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, slug)
);

create index if not exists plans_product_id_idx on public.plans (product_id);

create table if not exists public.activation_codes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  plan_id uuid references public.plans(id),
  code text not null unique check (length(btrim(code)) > 0),
  status text not null default 'available' check (status in ('available', 'reserved', 'sent', 'cancelled', 'invalid')),
  assigned_order_id uuid,
  assigned_customer_id uuid references public.customers(id),
  reserved_at timestamptz,
  sent_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists activation_codes_status_idx on public.activation_codes (status);
create index if not exists activation_codes_product_id_idx on public.activation_codes (product_id);
create index if not exists activation_codes_plan_id_idx on public.activation_codes (plan_id);
create index if not exists activation_codes_assigned_customer_id_idx on public.activation_codes (assigned_customer_id);
create index if not exists activation_codes_assigned_order_id_idx on public.activation_codes (assigned_order_id);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default public.generate_order_number(),
  customer_id uuid not null references public.customers(id),
  product_id uuid not null references public.products(id),
  plan_id uuid references public.plans(id),
  status text not null default 'pending_payment' check (
    status in (
      'draft',
      'pending_payment',
      'receipt_under_review',
      'paid',
      'code_reserved',
      'code_sent',
      'waiting_stock',
      'manual_review',
      'cancelled',
      'refunded',
      'failed'
    )
  ),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'BRL',
  payment_provider text,
  payment_reference text,
  paid_at timestamptz,
  code_id uuid references public.activation_codes(id),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.activation_codes
  add constraint activation_codes_assigned_order_id_fkey
  foreign key (assigned_order_id) references public.orders(id);

create index if not exists orders_customer_id_idx on public.orders (customer_id);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_payment_reference_idx on public.orders (payment_reference);
create index if not exists orders_created_at_idx on public.orders (created_at);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  provider text not null,
  provider_payment_id text,
  transaction_id text,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'refunded', 'chargeback', 'failed')),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'BRL',
  paid_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payments_provider_payment_id_unique_idx
  on public.payments (provider, provider_payment_id)
  where provider_payment_id is not null;
create unique index if not exists payments_transaction_id_unique_idx
  on public.payments (transaction_id)
  where transaction_id is not null;
create index if not exists payments_order_id_idx on public.payments (order_id);
create index if not exists payments_status_idx on public.payments (status);

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  customer_id uuid not null references public.customers(id),
  file_url text,
  file_path text,
  mime_type text,
  status text not null default 'uploaded' check (
    status in (
      'uploaded',
      'ai_processing',
      'ai_analyzed',
      'suspected_fraud',
      'approved_by_ai',
      'rejected_by_ai',
      'manual_review',
      'approved_by_human',
      'rejected_by_human'
    )
  ),
  extracted_amount_cents integer,
  extracted_currency text,
  extracted_date timestamptz,
  extracted_payer_name text,
  extracted_receiver_name text,
  extracted_transaction_id text,
  ai_confidence numeric,
  risk_score numeric,
  ai_summary text,
  ai_raw_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists receipts_order_id_idx on public.receipts (order_id);
create index if not exists receipts_customer_id_idx on public.receipts (customer_id);
create index if not exists receipts_status_idx on public.receipts (status);
create index if not exists receipts_extracted_transaction_id_idx on public.receipts (extracted_transaction_id);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  channel text not null check (channel in ('whatsapp', 'webchat', 'instagram', 'manual')),
  external_conversation_id text,
  status text not null default 'open' check (status in ('open', 'pending', 'closed', 'archived')),
  last_message_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_customer_id_idx on public.conversations (customer_id);
create index if not exists conversations_channel_idx on public.conversations (channel);
create index if not exists conversations_status_idx on public.conversations (status);
create index if not exists conversations_external_conversation_id_idx on public.conversations (external_conversation_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id),
  customer_id uuid references public.customers(id),
  role text not null check (role in ('customer', 'assistant', 'system', 'human_agent', 'tool')),
  content text,
  content_type text not null default 'text',
  external_message_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_id_idx on public.messages (conversation_id);
create index if not exists messages_customer_id_idx on public.messages (customer_id);
create index if not exists messages_role_idx on public.messages (role);
create index if not exists messages_created_at_idx on public.messages (created_at);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_type text not null,
  event_id text,
  idempotency_key text,
  status text not null default 'received' check (status in ('received', 'processing', 'processed', 'ignored', 'failed')),
  raw_payload jsonb not null default '{}'::jsonb,
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists webhook_events_provider_event_id_unique_idx
  on public.webhook_events (provider, event_id)
  where event_id is not null;
create unique index if not exists webhook_events_idempotency_key_unique_idx
  on public.webhook_events (idempotency_key)
  where idempotency_key is not null;
create index if not exists webhook_events_provider_idx on public.webhook_events (provider);
create index if not exists webhook_events_event_type_idx on public.webhook_events (event_type);
create index if not exists webhook_events_status_idx on public.webhook_events (status);

create table if not exists public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id),
  customer_id uuid references public.customers(id),
  order_id uuid references public.orders(id),
  action_name text not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'executed', 'failed')),
  input_payload jsonb not null default '{}'::jsonb,
  output_payload jsonb not null default '{}'::jsonb,
  requires_human_approval boolean not null default false,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_actions_conversation_id_idx on public.agent_actions (conversation_id);
create index if not exists agent_actions_customer_id_idx on public.agent_actions (customer_id);
create index if not exists agent_actions_order_id_idx on public.agent_actions (order_id);
create index if not exists agent_actions_action_name_idx on public.agent_actions (action_name);
create index if not exists agent_actions_status_idx on public.agent_actions (status);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('system', 'ai_agent', 'human_admin', 'webhook', 'customer')),
  actor_id text,
  action text not null,
  entity_type text,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_actor_type_idx on public.audit_logs (actor_type);
create index if not exists audit_logs_action_idx on public.audit_logs (action);
create index if not exists audit_logs_entity_type_id_idx on public.audit_logs (entity_type, entity_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at);

create table if not exists public.app_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null default '{}'::jsonb,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'customers',
    'products',
    'plans',
    'activation_codes',
    'orders',
    'payments',
    'receipts',
    'conversations',
    'agent_actions',
    'app_settings'
  ]
  loop
    execute format('drop trigger if exists %I_handle_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger %I_handle_updated_at before update on public.%I for each row execute function public.handle_updated_at()',
      table_name,
      table_name
    );
  end loop;
end;
$$;

alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.plans enable row level security;
alter table public.activation_codes enable row level security;
alter table public.orders enable row level security;
alter table public.payments enable row level security;
alter table public.receipts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.webhook_events enable row level security;
alter table public.agent_actions enable row level security;
alter table public.audit_logs enable row level security;
alter table public.app_settings enable row level security;
