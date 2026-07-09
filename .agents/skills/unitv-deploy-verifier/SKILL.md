---
name: unitv-deploy-verifier
description: Use antes de afirmar que algo esta corrigido, pronto, publicado, implantado, rodando, com testes passando, worker online, PM2 recarregado ou health checks ok no projeto UNITV Agent.
---

# UNITV Deploy Verifier

Esta skill impede o Codex de dizer que corrigiu sem validar.

## Regra principal

Nao afirmar sucesso sem rodar comandos ou verificar evidencia real.

Se nao conseguiu validar, dizer:

```txt
Implementei a alteracao, mas nao consegui validar X porque Y.
```

## Validacoes locais

Detectar scripts reais no `package.json`. Rodar conforme disponivel:

- `npm test`
- `npm run build`
- `npm run typecheck`
- `npm run lint`

Nao inventar comando se nao existir.

## Validacoes de bug

Para bugs de conversa:

- rodar teste de regressao criado;
- verificar que resposta proibida nao aparece;
- simular cenario manualmente quando possivel.

Para follow-up:

- testar antes do tempo;
- testar depois do tempo;
- testar cancelamento se cliente respondeu;
- testar bloqueio se contexto mudou.

Para pagamento:

- nao enviar evento fake em producao;
- nao confirmar pagamento manualmente sem ambiente seguro;
- validar com mocks ou ambiente de teste.

## Validacao de Obsidian

Quando bug exigiu aprendizado, verificar se o arquivo foi atualizado e se tem caso real, o que fazer, o que nunca fazer, resposta correta e teste obrigatorio.

## Validacao de deploy em VPS

Se o usuario pediu deploy real e o ambiente permitir acesso:

- rodar build;
- recarregar PM2 quando necessario;
- verificar `pm2 status`;
- verificar health checks disponiveis.

Comandos comuns, apenas se fizer sentido no projeto:

```bash
pm2 status
curl http://localhost:3000/api/health
curl http://localhost:3000/api/health/db
curl http://localhost:3000/api/health/ai
```

Adaptar porta e endpoints ao projeto real.

## O que nao fazer

Nunca:

- dizer "corrigido" sem teste;
- dizer "deploy feito" sem deploy real;
- dizer "PM2 online" sem verificar;
- dizer "health ok" sem checagem;
- rodar comando destrutivo sem autorizacao;
- commitar `.env`;
- expor token em log;
- enviar evento fake de compra em producao;
- apagar conversa/dados sem backup.

## Relatorio final

Ao final, responder com:

- o que foi feito;
- arquivos alterados;
- validacoes executadas;
- Obsidian, quando aplicavel;
- observacoes e limitacoes.

## Checklist

- Testes relevantes rodados.
- Build/typecheck/lint rodados quando disponiveis.
- Obsidian verificado quando aplicavel.
- Nenhum segredo exposto.
- Nenhum dado sensivel commitado.
- Nao afirmou deploy sem deploy real.
- Resultado final tem evidencia.
