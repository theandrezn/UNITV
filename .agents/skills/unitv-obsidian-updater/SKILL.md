---
name: unitv-obsidian-updater
description: Use sempre que corrigir bug real, alterar fluxo comercial, adicionar regra de atendimento, registrar o que fazer/nunca fazer ou transformar intervencao do Andre em aprendizado no Obsidian.
---

# UNITV Obsidian Updater

Esta skill mantem o Obsidian como base viva de conhecimento do agente UNITV.

## Quando usar

Use quando corrigir bug real, receber print de conversa, criar regra de atendimento, alterar fluxo de teste/download/venda, ajustar follow-up, adicionar "o que nunca fazer", aprender com resposta do Andre ou criar novo exemplo de resposta.

## Vault esperado

Procurar por vault ou pasta com nomes parecidos:

```txt
UNITV-KNOWLEDGE-BASE
obsidian
knowledge-base
docs/obsidian
```

Nao assumir caminho fixo sem procurar. Se nao encontrar o vault, criar pendencia em `docs/obsidian-updates-pending.md`.

## Arquivos prioritarios

Atualizar arquivos existentes com nomes parecidos com:

- `00_INDEX`
- `01_IDENTIDADE_DO_AGENTE`
- `02_O_QUE_NUNCA_FAZER`
- `O_QUE_FAZER_SE_RECEBER_ESSA_PERGUNTA`
- `FLUXOS_DE_ATENDIMENTO`
- `FOLLOWUPS`
- `MELHORIA_CONTINUA`
- `CASOS_REAIS_E_BUGS_APRENDIDOS`
- `FAQ`

Nao criar duplicado se arquivo equivalente ja existir.

## Regra anti-duplicidade

Antes de adicionar nova regra:

1. procurar regra parecida;
2. se existir, atualizar a secao existente;
3. se nao existir, criar nova secao;
4. manter linguagem simples e operacional.

## Formato obrigatorio para bug aprendido

```markdown
## Bug aprendido: {{titulo_curto}}

### Caso real

Descrever o que aconteceu de forma curta.

### Por que estava errado

Explicar por que a resposta do agente foi ruim.

### O que fazer

- Regra pratica 1.
- Regra pratica 2.
- Regra pratica 3.

### O que nunca fazer

- Nunca fazer X.
- Nunca fazer Y.
- Nunca fazer Z.

### Resposta correta esperada

> Exemplo de resposta que o agente deveria enviar.

### Estado correto

`nome_do_estado`

### Teste de regressao obrigatorio

Descrever o cenario que precisa ser coberto por teste.
```

## Exemplos conhecidos

- Nao fazer handoff humano em fluxo simples de teste/download.
- Nao reiniciar conversa depois de enviar link de download.
- Nao perder contexto quando cliente responde "nao" apos pergunta de primeira vez/teste.
- Nao enviar follow-up pos-download antes do tempo correto.

## Linguagem

Escrever como regra pratica para atendimento. Evitar texto tecnico demais. O objetivo e ensinar o agente e o Andre a reconhecer o que fazer, o que nunca fazer, qual resposta usar e qual estado manter.

## Checklist

- Vault localizado ou pendencia criada.
- Arquivo correto atualizado.
- Nao criou duplicidade desnecessaria.
- Caso real registrado.
- O que fazer registrado.
- O que nunca fazer registrado.
- Resposta correta registrada.
- Teste obrigatorio descrito.
