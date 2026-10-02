#!/usr/bin/env bash
set -e
mkdir -p "$DADOS_DIR/saida" "$DADOS_DIR/logs"

# lista editável pelo painel fica no volume; na primeira vez copia a da imagem
[ -f "$DADOS_DIR/rejeitados.txt" ] || cp /app/rejeitados.txt "$DADOS_DIR/rejeitados.txt"

# container novo: travas da rodada anterior e do Chrome não valem mais
rm -f "$DADOS_DIR/saida/.rodando" "$DADOS_DIR/saida/.publicando"
rm -f "$DADOS_DIR"/perfil-*/Singleton* 2>/dev/null || true

# tela virtual: o ChatGPT bloqueia Chrome sem janela (headless)
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &

exec node agendador.js
