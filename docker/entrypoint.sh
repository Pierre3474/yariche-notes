#!/bin/sh
# Démarre en root juste le temps de rendre /app/data au compte « node » (données créées
# par une ancienne image qui tournait en root), puis lance Yariche sans privilèges.
set -e
if [ "$(id -u)" = "0" ]; then
  if [ -d /app/data ] && [ "$(stat -c %u /app/data)" != "$(id -u node)" ]; then
    echo "[yariche] /app/data rendu au compte node (première exécution sans root)"
    chown -R node:node /app/data
  fi
  # Plus aucune capacité ensuite, même dans l'ensemble limite : impossible d'en regagner
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all "$@"
fi
exec "$@"
