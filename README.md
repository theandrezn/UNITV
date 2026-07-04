# UNITV Agent Foundation

Base tecnica inicial para um sistema de atendimento automatizado da operacao UniTV/UNITV Player.

Esta etapa prepara banco, ambiente, clients server-side, repositories, services e health checks. Ela nao implementa chat completo, envio de codigo, WhatsApp, upload completo de comprovante nem automacao de pagamento.

## Stack

- Next.js App Router
- TypeScript
- Supabase PostgreSQL
- Supabase JS client
- OpenAI SDK oficial
- Zod
- Vitest

## Seguranca

- `OPENAI_API_KEY` deve existir somente no backend.
- `SUPABASE_SERVICE_ROLE_KEY` deve existir somente no backend.
- O frontend nao deve ler tabelas sensiveis diretamente.
- `activation_codes`, `payments`, `receipts`, `audit_logs` e `webhook_events` nao possuem policies publicas.
- Todas as tabelas principais estao com RLS ativado.
- A liberacao de codigo nao esta implementada nesta etapa.
- A reserva de codigo so muda status de `available` para `reserved`.
- Webhooks devem usar `idempotency_key` ou `provider + event_id` para evitar processamento duplicado.

## Variaveis de ambiente

Copie o exemplo:

```bash
cp .env.example .env.local
```

Preencha:

```env
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_URL=

OPENAI_API_KEY=
OPENAI_MODEL=

APP_ENV=development
APP_BASE_URL=
WEBHOOK_SECRET=
```

`OPENAI_MODEL` pode ficar vazio; o codigo usa `gpt-4o-mini` como default.

`SUPABASE_DB_URL` e necessario para ferramentas e scripts diretos de banco, mas os clients server-side usam `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.

## Supabase

1. Crie ou selecione um projeto Supabase.
2. Preencha as variaveis em `.env.local`.
3. Instale a Supabase CLI se ainda nao tiver.
4. Aplique a migration localmente ou em um projeto vinculado.

Para um ambiente local:

```bash
supabase start
supabase db reset
```

Para um projeto remoto vinculado:

```bash
supabase link --project-ref SEU_PROJECT_REF
supabase db push
```

O seed em `supabase/seed.sql` cria o produto `UniTV` e os planos iniciais. Ele nao insere codigos reais.

## Health checks

Com o app rodando:

```bash
npm run dev
```

Teste:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/health/db
curl http://localhost:3000/api/health/ai
```

`/api/health/db` consulta apenas a contagem de `products` sem retornar dados sensiveis.

`/api/health/ai` valida a configuracao do client OpenAI e retorna o modelo configurado, sem retornar chave.

## Estrutura

```text
src/app/api/health
src/app/api/health/db
src/app/api/health/ai
src/lib/env.ts
src/lib/supabase/server.ts
src/lib/supabase/public.ts
src/lib/openai/client.ts
src/repositories
src/services
src/types/domain.ts
supabase/migrations
supabase/seed.sql
tests
```

## Scripts

```bash
npm run dev
npm run build
npm run lint
npm run typecheck
npm test
```

## Banco inicial

A migration cria:

- `customers`
- `products`
- `plans`
- `activation_codes`
- `orders`
- `payments`
- `receipts`
- `conversations`
- `messages`
- `webhook_events`
- `agent_actions`
- `audit_logs`
- `app_settings`

Tambem cria:

- `handle_updated_at()`
- triggers de `updated_at`
- `generate_order_number()` no formato `UTV-YYYYMMDD-XXXXXX`
- indices para busca e idempotencia
- RLS em todas as tabelas principais

## Proximas etapas recomendadas

1. Definir Auth e policies minimas para painel admin.
2. Implementar upload seguro de comprovante.
3. Implementar webhook de pagamento com assinatura e idempotencia.
4. Implementar agente de atendimento com historico de conversa.
5. Implementar painel admin.
6. Integrar WhatsApp.
