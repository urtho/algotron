# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install workspace root deps first (better layer caching)
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm install --workspace=backend --ignore-scripts

COPY backend ./backend
RUN npm run build -w backend

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/backend/dist ./dist

# Re-install only production dependencies
COPY backend/package.json ./
RUN npm install --omit=dev --ignore-scripts

ENV RELAY_SRV=_algobootstrap._tcp.mainnet.algorand.net
ENV ARCHIVER_SRV=_archive._tcp.mainnet.algorand.net
ENV NETWORK_ID=mainnet-v1.0

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/server.js"]
