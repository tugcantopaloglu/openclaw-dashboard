FROM node:24-alpine

RUN apk add --no-cache docker-cli curl

WORKDIR /app

COPY server.js index.html ./
COPY scripts/ ./scripts/

RUN chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV DASHBOARD_PORT=3001
ENV DASHBOARD_ALLOW_HTTP=true

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://127.0.0.1:${DASHBOARD_PORT:-3001}/ || exit 1

CMD ["node", "server.js"]
