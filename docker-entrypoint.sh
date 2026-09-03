#!/bin/sh
set -e

# Volume za DATA_DIR često dolazi u vlasništvu root-a — tako ga Docker napravi
# pri prvom montiranju, a i raniji Nixpacks build je radio kao root. Bot ipak
# radi kao neprivilegovan korisnik, pa bi upis istorije pukao na EACCES.
#
# Zato kontejner starta kao root samo koliko da sredi vlasništvo, pa odmah
# spusti privilegije. Ako već radi kao ne-root (npr. `docker run --user`),
# preskačemo i pokrećemo direktno.

DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIR"
  chown -R node:node "$DIR"
  exec su-exec node "$@"
fi

exec "$@"
