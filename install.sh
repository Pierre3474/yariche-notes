#!/bin/sh
# Installation de Yariche en une commande.
#   ./install.sh            Docker (recommandé, serveur ou poste)
#   ./install.sh --local    sans Docker (Node.js 22 ou plus)
# Crée le fichier .env (secrets générés), démarre Yariche et affiche l'adresse.
# Relançable sans risque : un .env existant n'est jamais écrasé.
set -eu
cd "$(dirname "$0")"

MODE=docker
[ "${1:-}" = "--local" ] && MODE=local

rand() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

if [ ! -f .env ]; then
  PORT=${YARICHE_PORT:-5174}
  cat > .env <<ENV
# Généré par install.sh. Voir .env.example pour toutes les options.
YARICHE_PORT=$PORT
# Connexion par comptes Yariche (page de connexion intégrée)
AUTH_MODE=local
SESSION_SECRET=$(rand)
# Code demandé une seule fois, pour créer le premier compte administrateur
SETUP_CODE=$(rand | cut -c1-16)
# Inscription libre : laisser à false, l'administrateur ajoute les comptes
ALLOW_SIGNUP=false
# Derrière un reverse proxy HTTPS (Traefik, Caddy, nginx) : TRUST_PROXY=1
ENV
  chmod 600 .env
  echo "Fichier .env créé."
fi
SETUP_CODE=$(sed -n 's/^SETUP_CODE=//p' .env | head -1)
PORT=$(sed -n 's/^YARICHE_PORT=//p' .env | head -1)
PORT=${PORT:-5174}

if [ "$MODE" = docker ]; then
  command -v docker >/dev/null 2>&1 || { echo "Docker est introuvable : https://docs.docker.com/get-docker/ (ou ./install.sh --local)" >&2; exit 1; }
  docker compose up -d --build
else
  command -v node >/dev/null 2>&1 || { echo "Node.js 22 ou plus est requis : https://nodejs.org" >&2; exit 1; }
  npm ci
  npx vite build
  set -a; . ./.env; set +a
  PORT=$PORT
  echo "Démarrage sans Docker (Ctrl+C pour arrêter)…"
fi

echo
echo "Yariche est prêt : http://localhost:$PORT"
if [ -n "$SETUP_CODE" ] && [ ! -f data/accounts.json ]; then
  echo "Première visite : crée le compte administrateur avec le code d'installation $SETUP_CODE"
fi
[ "$MODE" = local ] && exec env PORT="$PORT" node server/index.js
exit 0
