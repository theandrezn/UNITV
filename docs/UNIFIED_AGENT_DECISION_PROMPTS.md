# Prompts internos do decisor UNITV - ultra-low token

Estes prompts sao instrucoes internas de decisao, nao mensagens programadas para o cliente. Fatos e acoes sensiveis continuam sob regras locais e backend.

## Prompt 0 - roteador sem IA

Execute nesta ordem e pare na primeira regra segura:

1. agradecimento ou encerramento isolado -> `silent`;
2. saudacao de lead realmente novo -> saudacao oficial local;
3. conversa ativa -> nunca reiniciar com welcome;
4. preco generico -> somente mensal de R$ 20,90;
5. plano ou tabela explicitamente pedidos -> valor oficial solicitado;
6. Pix, pagamento, comprovante e codigo -> backend protegido;
7. aparelho, compatibilidade, download e instalacao -> matriz local;
8. ESPN, Premiere, espanhol e revenda -> conhecimento autoritativo local;
9. intencao clara de teste, ativacao ou recarga -> transicao local;
10. somente se ainda houver ambiguidade -> Prompt 1.

Esse roteador nao recebe historico longo, nao consulta OpenAI e nao cria texto por IA.

## Prompt 1 - unico decisor ambiguo

Versao em producao: `unitv-decision-v3-ultra-low`.

```text
Decida um turno ambiguo da UNITV. Retorne apenas o JSON curto solicitado.
Prioridade: estado > ultima pergunta > cliente > humano > base.
Passos: interprete; escolha uma acao; mantenha ou avance o estado; responda curto.
Acoes: reply, silent, wait, handoff. Use silent em agradecimento ou encerramento.
Handoff somente quando o cliente pedir humano ou tratar de revenda.
Nunca execute Pix, pagamento, codigo ou download; o backend e a autoridade.
Nunca saude conversa ativa, repita pergunta, invente fato ou regrida estado.
Quando responder, use 6 a 15 palavras, no maximo 22, com um unico proximo passo.
```

Saida obrigatoria de apenas sete campos:

```json
{
  "action": "reply | silent | wait | handoff",
  "intent": "intencao comercial",
  "next_state": "estado canonico",
  "meaning": "significado curto",
  "reason": "motivo curto",
  "reply": "resposta final curta",
  "confidence": 0.0
}
```

O backend expande localmente esses sete campos para o contrato completo. A IA nunca decide `should_generate_pix`, `should_create_order`, `should_send_download`, pagamento aprovado ou entrega de codigo.

## Contexto maximo permitido

- mensagem atual: 180 caracteres;
- estado canonico: um campo;
- historico: duas mensagens de ate 140 caracteres;
- perfil: no maximo nove fatos curtos, sem aliases de estado;
- pedido: somente status, sem payload;
- ultima pergunta: 140 caracteres;
- conhecimento compilado: um trecho de ate 240 caracteres;
- aprendizado do especialista: dois sinais de ate 70 caracteres;
- nunca enviar conversa completa, identidade repetida, regras estaveis duplicadas, telefone, chave, Pix ou segredo.

## Prompt 2 - guardiao local depois da IA

```text
Valide localmente: uma unica acao; transicao permitida; resposta curta; sem saudacao regressiva;
sem pergunta repetida; sem artefato sensivel; sem Pix/codigo/pagamento criado pela IA.
Se falhar, use decisao deterministica segura. Nunca abra uma segunda chamada para reescrever.
```

## Limites permanentes

- no maximo uma chamada de decisao por turno;
- `max_output_tokens = 90` no decisor ambiguo;
- classificador separado desligado;
- redator contextual separado bloqueado quando o decisor ja respondeu;
- follow-ups em modo sombra e sem IA;
- aprendizado diario por IA desligado;
- telemetria registra `prompt_version`, `prompt_characters`, tokens e origem deterministica/IA, sem conversa bruta.

## Criterio de revisao

Uma ampliacao de prompt so pode entrar se existir falha real reproduzida, teste de regressao e evidencia de que uma regra local nao resolve. Preferir sempre adicionar uma regra curta ao roteador em vez de aumentar o contexto de todos os turnos.
