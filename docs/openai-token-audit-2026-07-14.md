# Auditoria e reducao maxima de tokens OpenAI - 2026-07-14

## Resultado da medicao

O painel apresentado registrou 120 requisicoes, 121.258 tokens no dia, sendo 110.468 de entrada e 10.790 de saida, com gasto de US$ 0,18. Portanto, 91,1% dos tokens estavam na entrada: o problema principal nao era o tamanho da mensagem enviada ao cliente, mas contexto, schema e chamadas repetidas.

A telemetria agregada do servidor, sem exportar conversas ou dados pessoais, encontrou:

| Tipo | Chamadas | Entrada | Saida | Media de entrada |
|---|---:|---:|---:|---:|
| `context_interpretation` | 30 | 46.850 | 5.873 | 1.562 |
| `contextual_response` | 28 | 28.073 | 1.369 | 1.003 |
| `audio_transcription` | 2 | 452 | 143 | 226 |

Os dois fluxos textuais somaram 74.923 tokens de entrada observados. O segundo redator sozinho representou 37,5% dessa entrada e repetia parte do contexto que o interpretador ja havia recebido.

## Causas raiz

1. Quase todo turno ambiguo abria interpretacao e depois redacao.
2. O interpretador exigia JSON de 21 campos e reservava 200 tokens de saida.
3. Quatro mensagens recentes, aliases duplicados de estado, perfil extenso e dois artigos eram enviados a cada chamada.
4. Identidade, regras estaveis e conhecimento markdown eram recarregados mesmo quando o codigo ja sabia a resposta.
5. Perguntas oficiais de preco, planos, catalogo, aparelho e recarga ainda podiam chegar a IA antes das regras locais.

## Alteracoes aplicadas

- uma unica chamada maxima por turno, com o redator posterior bloqueado;
- rotas sem OpenAI para agradecimento, saudacao real, preco generico, tabela solicitada, preco de plano, ESPN, Premiere, espanhol, revenda, ativacao, renovacao, aparelhos e incompatibilidade;
- resposta `silent` local para encerramento e para aparelho incompatível ja confirmado;
- schema da IA reduzido de 21 para 7 campos;
- teto de saida reduzido de 200 para 90 tokens;
- historico reduzido de 4 x 240 para 2 x 140 caracteres;
- mensagem atual reduzida de 300 para 180 caracteres;
- perfil reduzido aos nove fatos operacionais, com somente um `conversation_state`;
- conhecimento reduzido de 2 x 420 para 1 x 240 caracteres, vindo do artefato compilado;
- removidas tres consultas de conhecimento por chamada (`identity`, `never_do` e busca markdown);
- aprendizado do especialista limitado a dois sinais curtos;
- telemetria ganhou versao e tamanho do prompt e origem da decisao;
- classificador separado, aprendizado diario e follow-ups com envio continuam desativados.

## Meta mensuravel

Se todos os 30 turnos do interpretador ainda fossem ambiguos, a meta de ate 800 tokens de entrada por chamada levaria 46.850 para aproximadamente 24.000 tokens. Somada a eliminacao dos 28 redatores, a reducao projetada para um volume comparavel e de cerca de 68%.

Como varias perguntas agora sao deterministicas e nao abrem chamada alguma, a faixa operacional esperada e de 68% a 85% menos tokens textuais. Isso e uma meta para validar em trafego real, nao uma garantia de faturamento.

Metas de regressao:

- `contextual_response` igual a zero no fluxo normal;
- no maximo uma chamada de decisao por turno;
- media de entrada de `context_interpretation` menor ou igual a 800;
- media de saida menor ou igual a 90;
- `reasoning_tokens` igual a zero;
- chamadas deterministicas registradas sem consumo OpenAI.

## Sobre cache de prompt

O cache automatico da OpenAI exige correspondencia exata de prefixo e passa a atuar em prompts a partir de 1.024 tokens. O novo objetivo e ficar abaixo desse tamanho; por isso, reduzir e eliminar chamadas produz mais economia real do que aumentar o prompt apenas para buscar cache. A orientacao oficial esta em [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Seguranca

Nenhuma chave, conversa bruta, telefone ou payload de Pix foi incluido nesta auditoria. Preco, pagamento, cobranca, comprovante e codigo permanecem sob validacao deterministica e backend real.
