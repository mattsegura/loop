# Production image for Loop MCP Gateway (single deployable Node 22 service)
FROM node:22-slim

WORKDIR /app

# Create a non-root user and persistent data volume
RUN groupadd -r loop && useradd -r -g loop -d /app -s /sbin/nologin loop \
  && mkdir -p /data \
  && chown -R loop:loop /data /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=loop:loop server.mjs stdio.mjs ./
COPY --chown=loop:loop bin ./bin
COPY --chown=loop:loop lib ./lib
COPY --chown=loop:loop public ./public
COPY --chown=loop:loop skills ./skills

USER loop

ENV NODE_ENV=production
ENV PORT=3847
ENV LOOP_HUB_DATA=/data

VOLUME ["/data"]
EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3847) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
