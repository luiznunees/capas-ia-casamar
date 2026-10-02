# Automação das capas com IA (Casa Mar) para o Easypanel.
# Um processo só (agendador.js): painel web + rodadas da IA + publicação no Jetimob/site.
FROM node:22-bookworm

ENV TZ=America/Sao_Paulo \
    DADOS_DIR=/dados \
    CHATGPT_PERFIL=/dados/perfil-chatgpt \
    JETIMOB_PERFIL=/dados/perfil-jetimob \
    PAINEL_HOST=0.0.0.0 \
    PAINEL_PORTA=3020 \
    DISPLAY=:99

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chrome \
 && apt-get update \
 && apt-get install -y --no-install-recommends xvfb tzdata fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY . .

# fotos, logs, logins do Chrome e listas editáveis: tudo no volume, sobrevive aos deploys
VOLUME /dados
EXPOSE 3020
CMD ["bash", "docker-entrypoint.sh"]
