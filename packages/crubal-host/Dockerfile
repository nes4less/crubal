# The reference host in a container (docs/design/completion.md O): the three packages, one process.
# Build from the packages directory:  docker build -f crubal-host/Dockerfile -t crubal-host .
FROM node:24-alpine
WORKDIR /app
COPY crubal/package.json crubal/package-lock.json* ./crubal/
COPY crubal-postgres/package.json crubal-postgres/package-lock.json* ./crubal-postgres/
COPY crubal-host/package.json crubal-host/package-lock.json* ./crubal-host/
RUN cd crubal && npm ci --omit=dev 2>/dev/null || npm install --omit=dev; \
    cd ../crubal-postgres && (npm ci --omit=dev 2>/dev/null || npm install --omit=dev); \
    cd ../crubal-host && (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)
COPY crubal ./crubal
COPY crubal-postgres ./crubal-postgres
COPY crubal-host ./crubal-host
WORKDIR /app/crubal-host
ENV NODE_ENV=production
EXPOSE 8787
# CRUBAL_PG_URL, CRUBAL_HOST_DOMAIN and CRUBAL_HOST_KEY come from the environment.
CMD ["node", "bin/crubal-host.ts", "serve", "--port", "8787"]
