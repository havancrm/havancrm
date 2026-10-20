FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# No dependencies to install: the server uses only Node's standard library.
COPY package.json ./
COPY server ./server
COPY app ./app

# Data (db.json and daily backups) lives on a mounted volume at /data.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server/server.js"]
