# Deploy no Easypanel

Um app só (Dockerfile) roda tudo: painel web, IA na madrugada e publicação assim que cada foto fica pronta.

## 1. Criar o app
Projeto → **+ Service → App**, nome `capas-ia`.
**Source:** GitHub, repositório deste projeto, branch `main`. **Build:** Dockerfile (o padrão, arquivo `Dockerfile` na raiz).

## 2. Environment
```
JET_EMAIL=...            # login do painel Jetimob
JET_SENHA=...
SITE_LOGIN=...           # admin do site (Atualizar Imóvel por Código)
SITE_SENHA=...
PAINEL_SENHA=...         # senha da tela de login do painel
PAINEL_USUARIO=admin     # opcional: usuário da tela de login (padrão admin)
```
Horário, IA/publicação automáticas, abas, prioridades e alertas no WhatsApp se ajustam no próprio painel (abas Controles e Alertas); as variáveis `JANELA_INICIO`, `JANELA_FIM`, `IA_AUTOMATICA=nao`, `PUBLICAR_AUTOMATICO=nao`, `PARALELO` e `EVOLUTION_*` só valem enquanto nada for salvo lá.

## 3. Mounts
**Volume**, nome `dados`, mount path `/dados`.
Guarda fotos, logs, `estado.json`, `publicados.json`, `rejeitados.txt` e os logins do Chrome — sem ele, cada deploy começa do zero.

## 4. Domains
Domínio (ex.: `capas.seudominio.com.br`) apontando para a **porta 3020**.

## 5. Recursos
O Chrome com 3 abas do ChatGPT usa ~1,5–2 GB de RAM. Se a VPS for pequena, use `--paralelo=1`
(troque no `agendador.js`) ou reserve memória para o app.

## 6. Primeiro acesso
1. Deploy. Abra o domínio e entre com a `PAINEL_SENHA`.
2. No Windows: `node melhorar.js --exportar-sessao` → gera `sessao-chatgpt.json`.
3. No painel, **Login do ChatGPT → Enviar sessao-chatgpt.json**. Ela é importada antes da próxima rodada da IA.
4. Logs: aba **Logs** do Easypanel (resumo) ou `/dados/logs/ia-AAAA-MM-DD.log` e `publicar-AAAA-MM-DD.log` (detalhe).

## Observações
- O ChatGPT pode pedir verificação (Cloudflare) para o IP da VPS. Se a IA falhar com "Resposta sem imagem",
  veja `/dados/saida/debug-ultimo-erro.png`.
- A sessão do ChatGPT expira de tempos em tempos: repita os passos 2 e 3.
