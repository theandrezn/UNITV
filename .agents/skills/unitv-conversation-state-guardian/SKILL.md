---
name: unitv-conversation-state-guardian
description: Use obrigatoriamente ao investigar ou alterar contexto de conversa, ChatAgentService, whatsapp-message.service, sales-response AI, classificacao de intencao, templates, estados, memoria, greeting, teste gratis, download, instalacao, venda, Pix, recarga, pagamento, codigo ou handoff humano do UNITV Agent.
---

# UNITV Conversation State Guardian

Esta skill protege o agente contra regressao de contexto.

## Principio central

A resposta do agente deve respeitar esta ordem:

1. Estado atual persistido.
2. Ultima mensagem do bot.
3. Ultima mensagem do cliente.
4. Ultimas mensagens do humano/Andre.
5. Follow-ups pendentes.
6. Intencao detectada pela IA.
7. So por ultimo: fluxo inicial.

A IA nunca pode ignorar o estado da conversa.

## Arquivos de atencao

Ao investigar estado/resposta, procurar primeiro em:

- `src/services/agent/chat-agent.service.ts`
- `src/services/whatsapp/whatsapp-message.service.ts`
- `src/lib/whatsapp/customer-message-safety.ts`
- `src/services/agent/sales-response-ai.service.ts`
- `src/services/agent/intent-classifier.service.ts`

## Estados minimos esperados

Usar estes estados ou equivalentes. O codigo tambem usa nomes reais como `welcome_activation`, `download_instructions`, `download_instructions_sent`, `awaiting_download_installation`, `install_support` e `post_download_check_10min`.

```txt
new_lead
welcome_sent
test_requested
first_time_check
device_qualification
download_link_sent
awaiting_download_installation
awaiting_test_activation
price_discovery
plan_preference
plan_selected
pix_permission
pix_sent
payment_pending
payment_approved
code_delivered
post_sale
human_handoff
```

## Regras de anti-regressao

### Nunca voltar para saudacao inicial se a conversa ja comecou

Bloquear mensagens como:

> Oi, tudo bem? Voce ja usa o aplicativo UNITV ou seria sua primeira vez?

se ja existe mensagem anterior do bot, pedido de teste, aparelho informado, link enviado, valor enviado, plano escolhido, Pix enviado, codigo entregue, intervencao humana ou follow-up ativo.

### Nunca voltar etapa

Exemplos proibidos:

- `download_link_sent` -> `welcome_sent`
- `pix_sent` -> `price_discovery`
- `plan_selected` -> `ask_plan_preference`
- `payment_pending` -> `test_requested`
- `code_delivered` -> `device_qualification`

### Ultima mensagem do bot manda muito

Se a ultima mensagem do bot foi pergunta, interpretar a resposta do cliente dentro daquela pergunta antes de usar greeting, fallback ou handoff.

## Respostas corretas por estado

### `device_qualification`

Se o cliente informa aparelho compativel, confirmar compatibilidade, enviar instrucao correta, orientar proximo passo, salvar estado de download/instalacao e nao fazer handoff.

### `download_link_sent` / `awaiting_download_installation`

- Cliente confirma Android: confirmar que o link enviado e correto e pedir para avisar apos instalar.
- Cliente diz que baixou: pedir para abrir o app e avisar se apareceu login/cadastro.
- Cliente diz que nao conseguiu: perguntar onde travou, link, Downloader ou instalacao.
- Cliente responde algo curto como "ok", "vou baixar", "E Android" ou "Android": manter instalacao, nunca saudacao.

### `price_discovery`

Se cliente pergunta valor genericamente, perguntar preferencia de plano. Nao despejar tabela completa cedo demais, exceto se pedir todos os valores.

### `pix_permission`

Se cliente demonstrou intencao de fechar, pedir permissao para enviar Pix. Nao gerar cobranca sem plano definido.

### `payment_pending`

Se cliente manda comprovante, nao confirmar pagamento automaticamente. Dizer que vai verificar e aguardar webhook/confirmacao real.

## Guarda obrigatoria

Antes de enviar resposta, validar ou criar equivalente de:

```ts
validateResponseAgainstConversationState(context, candidateResponse)
```

Ela deve bloquear:

- saudacao inicial em conversa ativa;
- handoff em fluxo simples;
- pergunta repetida;
- Pix sem plano definido;
- codigo sem pagamento aprovado;
- follow-up fora de contexto.

## Checklist

- Estado atual foi lido antes da resposta.
- Ultima pergunta do bot foi considerada.
- Resposta curta do cliente foi interpretada pelo contexto.
- Fluxo inicial nao venceu contexto ativo.
- Handoff so acontece por risco real.
- Pagamento/codigo continuam protegidos por validacao real.
