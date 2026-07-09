# AGENTS.md - Regras obrigatorias do projeto UNITV Agent

Este repositorio contem o UNITV Agent, um agente comercial e de suporte para WhatsApp.

O agente atende leads vindos de anuncio, qualifica o aparelho, oferece teste gratis, envia link de download, acompanha instalacao, conduz venda/recarga, lida com Pix e entrega codigo apenas apos confirmacao real de pagamento.

## Objetivo do agente

O agente deve parecer humano, contextual, consultivo e seguro.

Ele deve:

- entender o estagio atual da conversa;
- nunca reiniciar conversa em andamento;
- nao mandar mensagens fora de contexto;
- nao fazer handoff humano sem necessidade;
- nao atropelar o cliente;
- nao despejar tabela cedo demais;
- nao confirmar pagamento sem validacao real;
- aprender com bugs reais;
- manter o Obsidian atualizado com o que fazer e o que nunca fazer.

## Local das skills

As skills internas do projeto ficam em:

`.agents/skills/`

Antes de trabalhar, o Codex deve verificar a skill relacionada ao tipo de tarefa.

Para bugs reais, sempre comecar por:

1. `unitv-bug-learning-loop`
2. `unitv-conversation-state-guardian`
3. `unitv-regression-test-writer`
4. `unitv-obsidian-updater`
5. `unitv-deploy-verifier`

Para follow-ups, sempre usar:

1. `unitv-followup-auditor`
2. `unitv-conversation-state-guardian`
3. `unitv-regression-test-writer`
4. `unitv-obsidian-updater`
5. `unitv-deploy-verifier`

## Skills obrigatorias

### 1. unitv-bug-learning-loop

Usar sempre que houver:

- print de bug;
- conversa real com erro;
- mensagem fora de contexto;
- regressao;
- comportamento estranho do agente;
- handoff indevido;
- follow-up errado;
- cliente sendo mal conduzido.

Essa skill obriga: causa raiz, correcao, teste, Obsidian e validacao.

### 2. unitv-conversation-state-guardian

Usar sempre que mexer em:

- `ChatAgentService`;
- LLM;
- classificacao de intencao;
- estagios da conversa;
- templates;
- geracao de resposta;
- memoria de conversa;
- fluxo de teste/download/venda/recarga.

Essa skill protege o contexto da conversa.

### 3. unitv-followup-auditor

Usar sempre que mexer em:

- worker de follow-up;
- mensagens agendadas;
- regua de recuperacao;
- timers;
- cancelamento de follow-up;
- validacao antes de envio.

Essa skill impede follow-up antigo ou fora de contexto.

### 4. unitv-obsidian-updater

Usar sempre que:

- corrigir bug real;
- criar regra comercial;
- alterar fluxo de atendimento;
- descobrir novo "o que nunca fazer";
- adicionar aprendizado do especialista Andre.

Essa skill mantem o vault Obsidian como base viva do agente.

### 5. unitv-regression-test-writer

Usar sempre que corrigir bug ou alterar comportamento do agente.

Nenhuma correcao comportamental deve ser considerada pronta sem teste de regressao.

### 6. unitv-deploy-verifier

Usar antes de afirmar que algo esta pronto, publicado, corrigido ou implantado.

Obrigatorio rodar validacoes reais: testes, build, lint quando existir, health checks e PM2 quando aplicavel.

## Estados comerciais importantes

O agente deve respeitar estes estados ou equivalentes no codigo:

- `new_lead`
- `welcome_sent`
- `test_requested`
- `first_time_check`
- `device_qualification`
- `download_link_sent`
- `awaiting_download_installation`
- `awaiting_test_activation`
- `price_discovery`
- `plan_preference`
- `plan_selected`
- `pix_permission`
- `pix_sent`
- `payment_pending`
- `payment_approved`
- `code_delivered`
- `post_sale`
- `human_handoff`

## Regras de contexto

A prioridade para responder deve ser:

1. Ultimo estado conhecido da conversa.
2. Ultima mensagem enviada pelo bot.
3. Ultima mensagem enviada pelo cliente.
4. Mensagens recentes do humano/Andre.
5. Follow-ups pendentes.
6. So depois considerar fluxos iniciais.

Nunca priorizar saudacao inicial se a conversa ja esta em andamento.

## O que nunca fazer

O agente nunca deve:

- voltar para saudacao inicial depois que o fluxo avancou;
- perguntar "voce ja usa o aplicativo ou seria sua primeira vez?" depois de ja ter enviado link, valor, Pix ou codigo;
- encaminhar para humano em fluxo simples de teste/download/preco;
- tratar baixa confianca da IA como motivo automatico para handoff;
- mandar follow-up antigo sem revalidar contexto;
- mandar "Voce conseguiu baixar?" imediatamente apos o cliente responder;
- repetir pergunta que ja foi respondida;
- confirmar pagamento so porque o cliente mandou comprovante;
- gerar cobranca sem plano definido;
- enviar codigo antes de pagamento aprovado;
- apagar regras do Obsidian sem motivo;
- commitar dados sensiveis, conversas reais, tokens ou arquivos `.env`.

## Seguranca

Nunca expor, commitar ou registrar:

- tokens;
- API keys;
- access tokens da Meta;
- Mercado Pago secrets;
- dados pessoais completos de clientes;
- conversas brutas exportadas;
- arquivos em `data/training/`;
- `.env`;
- `.env.local`.

## Obsidian

O vault de conhecimento do UNITV deve ser tratado como fonte operacional de aprendizado.

Quando um bug real for corrigido, registrar no Obsidian:

- caso real;
- por que estava errado;
- o que fazer;
- o que nunca fazer;
- resposta correta esperada;
- teste de regressao obrigatorio.

Evitar duplicidade. Se ja existir regra parecida, atualizar a regra existente.

## Criterio para dizer "corrigido"

So dizer que corrigiu quando houver evidencia:

- teste criado/atualizado;
- teste passando;
- build passando;
- regra do Obsidian atualizada quando aplicavel;
- validacao manual do cenario;
- logs/health checks verificados quando houver deploy.

Se nao foi possivel validar, dizer claramente o que faltou.
