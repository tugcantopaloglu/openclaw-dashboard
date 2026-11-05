FROM node:24-alpine

RUN apk add --no-cache curl docker-cli jq

WORKDIR /app

COPY server.js index.html ./
COPY lib/ ./lib/
COPY scripts/ ./scripts/

RUN chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV DASHBOARD_PORT=3001
ENV DASHBOARD_HOST=0.0.0.0
ENV DASHBOARD_ALLOW_HTTP=true

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf "http://127.0.0.1:${DASHBOARD_PORT:-3001}/api/health" || exit 1

CMD ["node", "server.js"]
