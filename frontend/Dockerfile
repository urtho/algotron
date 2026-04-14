# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm install --workspace=frontend --ignore-scripts

COPY frontend ./frontend

ARG VITE_NETWORK_ID=mainnet-v1.0
ARG VITE_NETWORK_LABEL=ALGORAND MAINNET
ARG VITE_EXPLORER=https://allo.info

RUN npm run build -w frontend

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
