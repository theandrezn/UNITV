insert into public.products (name, slug, status)
values ('UNiTV / UniTV Player', 'unitv', 'active')
on conflict (slug) do update
set name = excluded.name,
    status = excluded.status,
    updated_at = now();

insert into public.plans (product_id, name, slug, duration_days, price_cents, currency, status, metadata)
select products.id, catalog.name, catalog.slug, catalog.duration_days, catalog.price_cents, 'BRL', 'active', catalog.metadata
from public.products
cross join (
  values
    ('Mensal', 'mensal', 30, 2500, '{"official": true}'::jsonb),
    ('3 meses', 'trimestral', 90, 7000, '{"official": true}'::jsonb),
    ('6 meses', 'semestral', 180, 12000, '{"official": true}'::jsonb),
    ('Anual', 'anual', 365, 20000, '{"official": true}'::jsonb),
    ('Teste gratis', 'teste', 3, 0, '{"official": true, "free_trial": true, "requires_human": true}'::jsonb)
) as catalog(name, slug, duration_days, price_cents, metadata)
where products.slug = 'unitv'
on conflict (product_id, slug) do update
set name = excluded.name,
    duration_days = excluded.duration_days,
    price_cents = excluded.price_cents,
    currency = excluded.currency,
    status = excluded.status,
    metadata = public.plans.metadata || excluded.metadata,
    updated_at = now();

create unique index if not exists knowledge_articles_category_title_unique_idx
  on public.knowledge_articles (category, title);

insert into public.knowledge_articles (category, title, content, status, metadata)
values
  (
    'produto',
    'O que e a UNiTV',
    'UNiTV e um aplicativo para assistir filmes, series e canais ao vivo em um so lugar. O atendimento deve apresentar como uma solucao pratica, rapida e completa, com foco em estabilidade, suporte e facilidade de instalacao.',
    'active',
    '{"official": true}'::jsonb
  ),
  (
    'planos',
    'Planos disponiveis',
    E'Planos disponiveis:\n- Mensal: R$ 25\n- 3 meses: R$ 70\n- 6 meses: R$ 120\n- Anual: R$ 200\n- Teste gratis: 3 dias\n\nO agente deve sempre buscar os precos reais da tabela public.plans antes de responder. Esta base serve como referencia textual, mas a fonte de verdade dos precos e public.plans.',
    'active',
    '{"official": true, "price_source": "public.plans"}'::jsonb
  ),
  (
    'instalacao',
    'Como instalar a UNiTV pelo Downloader',
    E'Passo 1: Instale o Downloader\n- Abra a Play Store da TV.\n- Pesquise por: Downloader by AFTVnews.\n- O icone e laranja.\n- Clique em instalar.\n\nPasso 2: Ative Fontes Desconhecidas\n- Va em Configuracoes.\n- Entre em Seguranca.\n- Procure Fontes desconhecidas.\n- Ative a opcao para o Downloader.\n\nPasso 3: Instale o UNiTV\n- Abra o aplicativo Downloader.\n- Digite o codigo: 862585.\n- Siga as instrucoes de instalacao na tela.',
    'active',
    '{"official": true}'::jsonb
  ),
  (
    'codigo_instalacao',
    'Codigo do Downloader',
    'Codigo UNiTV para o Downloader: 862585.',
    'active',
    '{"official": true}'::jsonb
  ),
  (
    'beneficios',
    'Beneficios principais',
    E'Beneficios:\n- Filmes, series e canais ao vivo no mesmo app.\n- Ativacao rapida.\n- Suporte personalizado.\n- Aplicativo estavel e atualizado.\n- Instalacao simples pelo Downloader.\n- Teste gratis de 3 dias, quando disponivel.',
    'active',
    '{"official": true}'::jsonb
  ),
  (
    'tutorial',
    'Tutorial em video',
    E'Tutorial de instalacao:\nhttps://www.youtube.com/watch?v=LBBAbs2-I0c',
    'active',
    '{"official": true}'::jsonb
  ),
  (
    'tom_atendimento',
    'Tom de atendimento',
    'O agente deve responder de forma curta, simples e direta, como atendimento de WhatsApp. Deve ajudar o cliente a escolher um plano, explicar a instalacao e orientar o pagamento. Nao deve mandar textos longos sem necessidade. Deve perguntar uma coisa por vez.',
    'active',
    '{"official": true}'::jsonb
  )
on conflict (category, title) do update
set content = excluded.content,
    status = excluded.status,
    metadata = public.knowledge_articles.metadata || excluded.metadata,
    updated_at = now();
