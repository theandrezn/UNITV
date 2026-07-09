---
name: unitv-regression-test-writer
description: Use sempre que corrigir bug, alterar fluxo de conversa, mudar resposta do agente, mexer em follow-up, handoff, pagamento, download, teste gratis ou logica comercial do UNITV Agent.
---

# UNITV Regression Test Writer

Nenhum bug comportamental deve ser corrigido sem teste de regressao.

## Principio

Testar comportamento observado pelo cliente, nao detalhe interno desnecessario.

O teste deve responder:

```txt
Dado um contexto de conversa,
quando o cliente envia X,
entao o agente deve responder Y
e nao deve enviar Z.
```

## Onde criar testes

Procurar padroes existentes em:

- `tests/`
- `src/**/*.test.ts`
- `src/**/*.spec.ts`
- `__tests__/`

Seguir o padrao do projeto. Evitar dependencia real de WhatsApp, OpenAI, Mercado Pago ou banco real; usar mocks/fakes.

## Todo teste de bug deve conter

- nome claro;
- contexto inicial;
- mensagem do cliente;
- resposta esperada;
- respostas proibidas;
- estado esperado apos resposta.

Respostas proibidas comuns:

- `Oi, tudo bem?`
- `Voce ja usa o aplicativo UNITV ou seria sua primeira vez?`
- `Vou encaminhar para atendimento humano`
- `Segue a chave Pix` sem plano
- `Pagamento confirmado` sem webhook

## Categorias

### Regressao de contexto

Dado estado ativo, cliente envia mensagem curta; agente deve manter etapa e nao reiniciar.

### Handoff humano

Dado pergunta pendente em fluxo simples; agente nao deve acionar humano antes da resposta.

### Follow-up

Testar antes do tempo, depois do tempo e cancelamento se cliente/humano respondeu ou contexto mudou.

### Venda

Cliente pergunta valor; agente deve qualificar plano/telas antes de jogar tabela completa, exceto quando cliente pedir todos os valores.

### Pagamento

Cliente manda comprovante; agente nao confirma pagamento nem entrega codigo sem confirmacao real.

## Testes minimos conhecidos

- Nao fazer handoff antes do cliente responder aparelho.
- Enviar link quando cliente responde Celular Android.
- Nao reiniciar conversa apos link quando cliente diz "E Android".
- Follow-up de download so depois do tempo configurado.
- Cancelar follow-up se cliente respondeu.
- Nao repetir saudacao quando cliente responde "Nao" apos pergunta sobre ja usar/teste.

## Se teste for dificil

Criar teste no nivel mais proximo possivel. Se fizer sentido, extrair funcao pura. Documentar limitacao se algo nao puder ser validado.

## Checklist

- Teste falharia antes da correcao.
- Teste passa depois da correcao.
- Teste cobre resposta proibida.
- Teste cobre estado correto.
- Teste nao depende de servico externo real.
- Nome do teste explica o bug.
