# APU — Telegram AI asistent (pozadinski worker, bez HTTP porta)
FROM node:22-alpine

# su-exec: entrypoint kratko radi kao root da sredi vlasništvo nad volumenom,
# pa spusti privilegije. Sve zavisnosti su čist JS, pa build alati ne trebaju.
RUN apk add --no-cache su-exec

WORKDIR /app

# Prvo samo manifest — bolji sloj-keš pri promeni koda.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Ostatak koda (uključujući assets/ sa fontovima i logom za fakture).
COPY . .

# Folder za trajne podatke (istorija razgovora, zapamćene činjenice, indeks
# pretrage). Na serveru montiraj kao volume, inače se gubi pri redeployu.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data \
    && chown -R node:node /app/data \
    && chmod +x docker-entrypoint.sh

# Namerno BEZ `USER node`: entrypoint spušta privilegije sam, pošto pre toga
# mora kao root da popravi vlasništvo montiranog volumena.
ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Bot koristi long polling — nema porta za expose.
CMD ["node", "src/index.js"]
