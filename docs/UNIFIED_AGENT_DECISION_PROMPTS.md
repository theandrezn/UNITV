# Prompts Internos Do Decisor UNITV

Este documento descreve a ordem operacional. Nao contem mensagens fixas para copiar; os prompts produzem decisoes estruturadas e respostas contextuais.

## Passo 1 - Reconstruir O Contexto

Entrada minima:

- `conversation_state` oficial;
- ultima mensagem do bot;
- ultima mensagem do cliente;
- intervencao recente do Andre;
- pedido/pagamento atual;
- capacidades conhecidas do aparelho;
- follow-up pendente;
- ate quatro mensagens recentes relevantes.

Prompt interno: determine o que a mensagem significa considerando primeiro o estado e a ultima pergunta. Nao trate mensagem curta como conversa nova.

## Passo 2 - Aplicar Regras Deterministicas

Resolver sem IA quando houver regra segura para preco, plano, Pix, pagamento, codigo, catalogo, download ou compatibilidade. Bloquear saudacao regressiva, pergunta repetida, falso handoff e instalacao para aparelho incompativel.

## Passo 3 - Chamada Unica Para Ambiguidade

Somente quando os passos anteriores nao forem suficientes, retornar um unico JSON com:

```json
{
  "intent": "significado comercial",
  "customer_message_meaning": "interpretacao contextual",
  "action": "reply | silent | wait | handoff | backend_action",
  "next_state": "estado canonico",
  "reason": "motivo auditavel",
  "recommended_response": "resposta curta pronta para envio"
}
```

Essa resposta nao pode ser reescrita por uma segunda IA. O limite tecnico do turno e uma chamada entre classificacao, interpretacao e redacao.

## Passo 4 - Arbitragem Final

O `ConversationBrain` recebe a decisao contextual e o candidato operacional. Ele devolve somente:

- `action`;
- `next_state`;
- `reason`;
- `reply`;
- `followup_action`;
- `backend_artifact`.

Nenhuma regra posterior pode mudar uma acao `silent` ou `wait` para `reply`.

## Passo 5 - Seguranca De Backend

`backend_action` apenas autoriza o fluxo protegido. Pix, pagamento e codigo continuam dependendo do backend real, pedido e webhook. O artefato registrado na decisao nunca contem segredo ou payload completo.

## Passo 6 - Modo Sombra

Registrar decisao antiga e decisao unificada sem armazenar conversa bruta. Classificar divergencias e medir tokens. Follow-ups em sombra registram o candidato deterministico e nao chamam IA nem WhatsApp.

## Passo 7 - Aprendizado E Conhecimento

Intervencoes do Andre permanecem candidatas ate revisao e evidencia de resultado. Regras novas precisam de tres exemplos positivos distintos. O Obsidian e compilado para JSON estruturado e validado antes do deploy.
