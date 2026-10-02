#!/usr/bin/env bash
# Instala a automação de fotos numa VPS Ubuntu/Debian e agenda no cron. Tudo automático:
#   melhorar.js --site   (de hora em hora)    gera as capas com o ChatGPT, prioritários primeiro
#   publicar.js --todos  (a cada 15 minutos)  sobe no Jetimob as que ficaram prontas e atualiza o site
# Cada um tem sua trava (saida/.rodando e saida/.publicando): se a rodada anterior ainda estiver
# em andamento, a nova sai na hora. Se algo cair, o próximo horário retoma de onde parou.
#
# Antes, no Windows:
#   node melhorar.js --exportar-sessao      (gera sessao-chatgpt.json)
# Copie para a VPS (SEM node_modules, perfil-chatgpt, perfil-jetimob e saida), por exemplo:
#   scp melhorar.js publicar.js painel.js painel.html recortar.js fotos.js prioridades.txt rejeitados.txt \
#       package.json package-lock.json instalar-vps.sh sessao-chatgpt.json .env \
#       usuario@IP:~/automacao-fotos/
# Na VPS:
#   cd ~/automacao-fotos && bash instalar-vps.sh
#
# Para mudar os horários: HORARIO_IA="0 1 * * *" HORARIO_PUBLICAR="*/30 * * * *" bash instalar-vps.sh
set -euo pipefail

HORARIO_IA="${HORARIO_IA:-0 * * * *}"
HORARIO_PUBLICAR="${HORARIO_PUBLICAR:-*/15 * * * *}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

[ -f .env ] || { echo "!! Falta o .env (login do Jetimob e do admin do site). Copie do Windows."; exit 1; }
[ -f sessao-chatgpt.json ] || { echo "!! Falta sessao-chatgpt.json. Gere no Windows com: node melhorar.js --exportar-sessao"; exit 1; }
chmod 600 .env sessao-chatgpt.json

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo ">> Instalando Node 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo ">> Instalando xvfb (tela virtual para o Chrome)..."
sudo apt-get install -y xvfb

echo ">> Instalando dependências..."
npm ci || npm install

echo ">> Instalando Google Chrome..."
sudo npx playwright install --with-deps chrome

mkdir -p logs saida

echo ">> Importando a sessão do ChatGPT..."
CHATGPT_PERFIL="$DIR/perfil-chatgpt" xvfb-run -a node melhorar.js --importar-sessao=sessao-chatgpt.json

echo ">> Testando o acesso ao admin do site..."
node publicar.js --so-site 16504

LINHA_IA="$HORARIO_IA cd $DIR && CHATGPT_PERFIL=$DIR/perfil-chatgpt xvfb-run -a node melhorar.js --site >> $DIR/logs/ia-\$(date +\%F).log 2>&1"
LINHA_PUB="$HORARIO_PUBLICAR cd $DIR && node publicar.js --todos >> $DIR/logs/publicar-\$(date +\%F).log 2>&1"
# painel (painel.js): sobe junto com o servidor; só escuta em 127.0.0.1 (acesse por túnel SSH)
LINHA_PAINEL="@reboot cd $DIR && CHATGPT_PERFIL=$DIR/perfil-chatgpt node painel.js >> $DIR/logs/painel.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'melhorar.js --site' | grep -v 'publicar.js --todos' | grep -v 'painel.js' ; echo "$LINHA_IA" ; echo "$LINHA_PUB" ; echo "$LINHA_PAINEL" ) | crontab -
echo ">> Cron instalado:"
crontab -l | grep -E 'melhorar.js|publicar.js|painel.js'

pkill -f 'node painel.js' 2>/dev/null || true
( cd "$DIR" && CHATGPT_PERFIL="$DIR/perfil-chatgpt" nohup node painel.js >> "$DIR/logs/painel.log" 2>&1 & )
echo
echo "Pronto. Acompanhe com:"
echo "  tail -f $DIR/logs/ia-\$(date +%F).log"
echo "  tail -f $DIR/logs/publicar-\$(date +%F).log"
echo "Painel: no seu computador rode  ssh -L 3020:localhost:3020 $(whoami)@IP_DA_VPS  e abra http://localhost:3020"
