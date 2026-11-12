# Algotron: one Bun process serves the dashboard, /ws and /health.
FROM oven/bun:1.4.3-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend
RUN bun run build

FROM oven/bun:1.4.3-alpine
WORKDIR /app
# HOST=:: listens on IPv4 and IPv6: platform health checks call "localhost", which resolves to ::1 first
ENV NODE_ENV=production PORT=3001 HOST=::
COPY --from=build /app/dist ./
USER bun
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1
CMD ["bun", "server.js"]
