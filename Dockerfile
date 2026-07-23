# APU — Telegram AI asistent (pozadinski worker, bez HTTP porta)
FROM node:22-alpine

WORKDIR /app

# Prvo samo manifest — bolji sloj-keš pri promeni koda.
COPY package*.json ./
RUN npm ci --omit=dev

# Ostatak koda.
COPY . .

# Folder za trajnu istoriju razgovora (montiraj kao volume u Coolify-ju!).
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app/data

# Ne radi kao root.
USER node

# Bot koristi long polling — nema porta za expose.
CMD ["node", "src/index.js"]
