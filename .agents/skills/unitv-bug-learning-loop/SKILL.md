---
name: unitv-bug-learning-loop
description: Use obrigatoriamente em qualquer bug real, print de WhatsApp, investigacao de causa raiz, comportamento fora de contexto, regressao, handoff indevido, follow-up errado, pergunta repetida, saudacao reiniciada, perda de estado, erro comercial ou pedido do usuario para analisar bug do agente UNITV, mesmo quando ele pedir apenas investigacao sem implementar.
---

# UNITV Bug Learning Loop

Esta skill e obrigatoria quando houver qualquer bug real do agente UNITV.

Todo bug precisa virar:

1. causa raiz;
2. correcao;
3. teste de regressao;
4. aprendizado no Obsidian;
5. validacao antes de conclusao.

## Quando usar

Use quando o usuario mencionar bug, erro, sem contexto, mensagem aleatoria, handoff desnecessario, suporte humano sem necessidade, follow-up errado, pergunta repetida, etapa voltando, cliente mal conduzido ou print do WhatsApp com comportamento ruim.

Use tambem quando o usuario pedir somente auditoria ou investigacao de um bug antigo. Nesse modo, nao implemente codigo; entregue causa raiz provavel, arquivo/funcao responsavel, teste de regressao esperado e regra do Obsidian.

## Processo obrigatorio

### 1. Reconstruir o caso real

Antes de editar codigo, reconstruir:

- ultima mensagem do cliente;
- ultima mensagem do bot;
- mensagem do humano/Andre, se houver;
- estado provavel da conversa;
- follow-up pendente, se houver;
- mensagem errada enviada;
- resposta correta esperada.

### 2. Classificar o bug

Use uma ou mais categorias:

- `context_regression`
- `wrong_handoff`
- `followup_out_of_context`
- `premature_followup`
- `duplicated_question`
- `stage_regression`
- `template_leak`
- `payment_safety`
- `download_flow_error`
- `sales_flow_error`
- `obsidian_rule_missing`

### 3. Encontrar a causa raiz

Investigue no codigo:

- servico de geracao de resposta;
- classificador de intencao;
- resolvedor de estagio;
- worker de follow-up;
- templates/fallbacks;
- integracao com Obsidian;
- logica de handoff humano;
- persistencia de estado da conversa.

Nao aceite "a IA se confundiu" como causa raiz. Descubra qual decisao do sistema permitiu o erro.

### 4. Definir comportamento correto

Escreva a resposta esperada e as respostas proibidas. Exemplo: depois de `download_link_sent`, cliente dizendo "E Android" deve manter instalacao, nao voltar para saudacao.

### 5. Corrigir no menor ponto seguro

Preferir guarda de estado, validacao de contexto, bloqueio de regressao, validacao antes de follow-up e testes comportamentais.

Evitar if hardcoded apenas para uma frase, template solto sem contexto, apagar logica sem entender ou resolver um bug criando outro.

### 6. Criar ou atualizar teste de regressao

Todo bug real precisa de teste. Teste comportamento observado pelo cliente:

- dado o contexto;
- quando o cliente envia X;
- entao o agente responde Y;
- e nao envia Z.

### 7. Atualizar Obsidian

Use a skill `unitv-obsidian-updater`. Registre caso real, por que estava errado, o que fazer, o que nunca fazer, resposta correta e teste obrigatorio.

### 8. Validar

Use a skill `unitv-deploy-verifier`. Rode testes relevantes, build/typecheck/lint quando existirem e validacao manual quando possivel.

## Skills que devem ser combinadas

Para bug real completo, usar tambem:

- `unitv-conversation-state-guardian`;
- `unitv-regression-test-writer`;
- `unitv-obsidian-updater`;
- `unitv-deploy-verifier`.

Para investigacao sem implementar, usar as tres primeiras, mas nao alterar codigo.

## Bugs reais conhecidos

### Handoff humano indevido no fluxo de teste/download

Se o bot acabou de perguntar aparelho em fluxo de baixo risco, o estado e `awaiting_customer_response`, nao `human_handoff`.

### Saudacao inicial depois do link de download

Depois de `download_link_sent`, nunca retornar para `welcome_sent` ou `new_lead`.

### Resposta curta com contexto

Se o bot perguntou se ja usou o UNITV/teste gratis e o cliente responde "nao", interpretar pelo contexto como primeira vez e avancar para aparelho.

## Checklist

- Causa raiz identificada.
- Correcao implementada.
- Teste de regressao criado/atualizado.
- Obsidian atualizado quando aplicavel.
- Testes relevantes executados.
- Build/typecheck/lint executados quando aplicavel.
- Limitacoes informadas se algo nao foi validado.
