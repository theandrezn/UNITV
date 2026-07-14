# Auditoria de tokens OpenAI - 2026-07-13

## Escopo e privacidade

Auditoria feita com `audit_logs` agregados por tipo de chamada, horario e modelo. Nenhuma conversa bruta, telefone, chave, prompt de cliente ou identificador individual foi exportado para este relatorio.

## Reproducao do painel

No intervalo de 20h00 a 20h59 (America/Sao_Paulo), a telemetria do servidor registrou:

| Tipo | Chamadas com sucesso | Entrada | Saida | Raciocinio dentro da saida | Total |
|---|---:|---:|---:|---:|---:|
| `context_interpretation` | 12 | 20.636 | 2.400 | 1.918 | 23.036 |
| `contextual_response` | 18 | 19.840 | 2.472 | 1.862 | 22.312 |
| **Total** | **30** | **40.476** | **4.872** | **3.780** | **45.348** |

O painel exibiu 40.488 tokens de entrada e 4.877 de saida. A diferenca de 12 tokens de entrada e 5 de saida e compativel com atraso/arredondamento de telemetria ou uma requisicao fora do observador; o consumo principal foi reproduzido.

As 30 chamadas foram distribuidas em sete conversas. Cinco tiveram os dois tipos de chamada e uma conversa acumulou dez chamadas ao longo de varias mensagens.

## Causa raiz

1. `reasoning: low` consumiu 3.780 tokens, ou 77,6% de toda a saida, embora o cliente recebesse somente uma mensagem curta.
2. O limite de 200 tokens do interpretador era disputado pelo raciocinio interno e pelo JSON estruturado. O JSON podia ficar incompleto, cair para a decisao deterministica e abrir uma segunda chamada de redacao.
3. Interpretacao e redacao recebiam historico e conhecimento novamente. O teto combinado de historico mais base era 3.750 caracteres variaveis por chamada.
4. O reaproveitamento da primeira resposta ja existia, mas dependia de o JSON do interpretador ser concluido e aceito pelas guardas.

Tentativas bloqueadas pelo circuito de quota nao consumiram tokens. Elas aparecem na telemetria para diagnostico, mas nao explicam os 40 mil do painel.

## Otimizacoes aplicadas

- Removido `reasoning: low` das chamadas textuais do `gpt-5.4-mini`; nesse modelo, a ausencia do parametro usa o modo direto `none`.
- Mantido o interpretador em 200 tokens para o JSON estruturado, agora sem competir com raciocinio oculto.
- Redacao normal reduzida de 140 para 100 tokens; casos complexos, de 190 para 140.
- Historico reduzido de cinco mensagens de 360 caracteres para quatro de 240.
- Base reduzida de tres trechos de 650 caracteres para dois de 420, priorizando o artigo relacionado a pergunta e uma guarda operacional.
- Teto de historico mais base reduzido de 3.750 para 1.800 caracteres por chamada, queda de 52% nessa parte variavel do prompt.
- Perfil, mensagem atual, contexto operacional e aprendizado do especialista ganharam limites menores e explicitos.
- A resposta segura do interpretador pode ser reutilizada tambem ao continuar recarga, sem abrir uma segunda redacao.
- Pix, pagamento, comprovante, codigo, links, valores e artefatos operacionais continuam fora desse atalho e sob validacao do backend.

## Economia esperada e como comprovar

- Em um intervalo equivalente, remover o raciocinio elimina ate 3.780 tokens de saida que nao chegavam ao cliente. Isso representa 77,6% da saida observada antes da mudanca.
- A reducao de entrada depende do preenchimento real do perfil e dos artigos. O teto de historico mais base caiu 52%, mas a economia total deve ser medida nas proximas chamadas reais.
- Ate 12 interpretacoes do intervalo poderiam evitar uma segunda escrita se retornarem JSON valido, confiavel e sem artefato sensivel. O numero real sera menor quando uma guarda exigir redacao protegida.

A comprovacao final deve comparar `input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_input_tokens`, chamadas por tipo e respostas reutilizadas depois do deploy. A meta operacional e `reasoning_tokens = 0` nas novas chamadas textuais do agente.
