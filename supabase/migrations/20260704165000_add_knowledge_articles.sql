create table if not exists public.knowledge_articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  content text not null,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_articles_category_idx on public.knowledge_articles (category);
create index if not exists knowledge_articles_status_idx on public.knowledge_articles (status);
create index if not exists knowledge_articles_created_at_idx on public.knowledge_articles (created_at);

drop trigger if exists knowledge_articles_handle_updated_at on public.knowledge_articles;
create trigger knowledge_articles_handle_updated_at
before update on public.knowledge_articles
for each row execute function public.handle_updated_at();

alter table public.knowledge_articles enable row level security;

insert into public.knowledge_articles (title, category, content, metadata)
values
  ('Saudacao inicial', 'greeting', 'Cumprimente de forma curta, pergunte como pode ajudar e conduza para compra, renovacao ou suporte.', '{"seed": true}'::jsonb),
  ('Planos', 'plans', 'Informe os planos ativos cadastrados no Supabase. Nao invente preco, duracao, canais ou conteudo especifico.', '{"seed": true}'::jsonb),
  ('Renovacao', 'renewal', 'Para renovacao, confirme o plano desejado e oriente pagamento. A validacao final deve ser manual nesta fase.', '{"seed": true}'::jsonb),
  ('Ativacao de codigo', 'activation', 'Nunca libere codigo automaticamente. Explique que a ativacao e enviada apos validacao manual do pagamento.', '{"seed": true}'::jsonb),
  ('Suporte tecnico', 'technical_support', 'Colete o problema, aparelho usado, aplicativo, mensagem de erro e se a internet esta funcionando.', '{"seed": true}'::jsonb),
  ('Comprovante', 'receipt', 'Ao receber comprovante em texto, imagem ou documento, confirme recebimento e avise que sera conferido manualmente.', '{"seed": true}'::jsonb),
  ('Atendimento humano', 'human_help', 'Quando o cliente pedir atendente ou o fluxo estiver confuso, encaminhe para atendimento humano sem prometer prazo exato.', '{"seed": true}'::jsonb),
  ('Duvidas frequentes', 'faq', 'Responda de forma objetiva e curta. Quando faltar informacao na base, diga que vai encaminhar para atendimento humano.', '{"seed": true}'::jsonb)
on conflict do nothing;

insert into public.app_settings (key, value, description)
values (
  'payment_instructions',
  '{"text": "Pagamento sob orientacao manual. Configure app_settings.payment_instructions ou PAYMENT_INSTRUCTIONS para enviar instrucoes reais."}'::jsonb,
  'Texto usado pelo agente para orientar pagamento quando um pedido e criado.'
)
on conflict (key) do nothing;
