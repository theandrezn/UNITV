---
name: unitv-followup-auditor
description: Use sempre que mexer em worker de follow-up, mensagens agendadas, regua de recuperacao, timers, cancelamento, revalidacao de contexto ou envio automatico do UNITV Agent.
---

# UNITV Follow-up Auditor

Esta skill impede follow-up antigo, duplicado ou fora de contexto.

## Regra principal

Todo follow-up deve ser revalidado no momento da execucao. O fato de ter sido agendado nao significa que ainda pode ser enviado.

## Antes de enviar follow-up, verificar

- Cliente respondeu depois do agendamento?
- Humano/Andre respondeu depois do agendamento?
- Estado avancou para pagamento, Pix, ativacao, venda concluida ou suporte humano?
- Ultima mensagem do bot combina com o follow-up?
- Existe follow-up igual pendente?
- O lead pediu para parar?
- Pagamento foi aprovado?
- Codigo ja foi entregue?

Se qualquer resposta indicar risco, cancelar/bloquear e registrar motivo.

## Tipos importantes

### Pos-download

Apos link/APK/codigo Downloader/tutorial/instrucao de instalacao, usar `post_download_check_10min`.

Enviar somente depois de 10 minutos sem resposta:

> Voce conseguiu baixar?

Personalizar quando o aparelho estiver claro:

- `Voce conseguiu baixar na TV Box?`
- `Voce conseguiu baixar no celular Android?`

Nao enviar se cliente respondeu, humano assumiu, estado mudou ou ja existe follow-up pos-download ativo.

### Pre-venda / Pix

Quando cliente disse que fara recarga depois, agendar conforme regra do projeto. Antes de enviar, confirmar que ainda ha intencao real, plano claro, sem pagamento aprovado e sem humano fechando venda.

### Pos-primeira mensagem

Se lead de anuncio nao respondeu qualificacao inicial, nao repetir sempre a mesma pergunta. Manter baixa pressao, progredir com contexto e nao mandar tabela cedo demais.

### Pos-valores

Se recebeu valores e nao escolheu plano, perguntar preferencia. Nao mandar Pix sem plano definido.

## Bloqueios de regressao

Follow-up nunca pode voltar para estagio anterior:

- conversa em `pix_sent` nao recebe follow-up de teste gratis;
- conversa em `download_link_sent` nao recebe saudacao inicial;
- conversa em `plan_selected` nao recebe pergunta generica de primeira vez;
- conversa em `payment_pending` nao recebe tabela de planos;
- conversa em `code_delivered` nao recebe oferta de teste.

## Funcao recomendada

Criar ou reforcar equivalente:

```ts
validateFollowupAgainstConversationContext(followup, context)
```

Retorno recomendado:

```ts
{
  allowed: boolean;
  reason: string;
  replacementFollowupType?: string;
  replacementMessage?: string;
  cancelOriginal?: boolean;
}
```

## Logs obrigatorios

Quando bloquear follow-up, registrar:

- `conversationId`;
- `followupType`;
- `reason`;
- `detectedStage`;
- `lastCustomerMessage`;
- `lastBotMessage`;
- `scheduledAt`;
- `runAt`;
- `action`.

## Testes obrigatorios

- Follow-up de download so depois do tempo configurado.
- Follow-up de download cancela se cliente respondeu.
- Follow-up antigo de boas-vindas nao executa se conversa avancou.
- Follow-up de Pix so executa se pre-venda ainda esta valida.
- Follow-up nao executa depois de mensagem humana.
- Follow-up nao executa depois de pagamento aprovado.
- Follow-up nao reinicia conversa.

## Checklist

- Todo follow-up revalida contexto na execucao.
- Follow-up antigo pode ser bloqueado/cancelado.
- Ha logs explicando bloqueios.
- Testes cobrem cenario real.
- Nenhuma mensagem agendada ignora resposta recente do cliente.
