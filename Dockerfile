# --- Build du client (Vite) --------------------------------------------------------
FROM node:25-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build

# --- Image finale ---------------------------------------------------------------------
# Debian 13 : nextcloudcmd 3.16 (le 3.7 de Debian 12 échoue sur l'envoi groupé de fichiers)
FROM node:25-trixie-slim
WORKDIR /app
ENV NODE_ENV=production
# UTF-8 obligatoire : sinon les noms de fichiers accentués (« Réunion.md ») sont abîmés
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# nextcloudcmd : client de synchronisation officiel de Nextcloud (synchro d'un coffre
# avec un dossier Nextcloud, dans les deux sens)
RUN apt-get update \
  && apt-get install -y --no-install-recommends nextcloud-desktop-cmd ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist

# Données (sessions, réglages, coffres) : à monter en volume
ENV DATA_DIR=/app/data PORT=5174
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
# Lancé en root puis sans privilèges (compte node), voir docker/entrypoint.sh
COPY docker/entrypoint.sh /usr/local/bin/yariche-entrypoint
ENTRYPOINT ["yariche-entrypoint"]

EXPOSE 5174
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5174)+'/favicon.svg').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
