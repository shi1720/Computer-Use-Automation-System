FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --omit=dev
COPY tsconfig*.json swivel.config.json ./
COPY capabilities ./capabilities
COPY evidence ./evidence
COPY scripts ./scripts
ENV NODE_ENV=production SWIVEL_CHROMIUM_PATH=/usr/bin/chromium SWIVEL_DATA_DIR=/tmp/swivel SWIVEL_EVIDENCE_DIR=/tmp/swivel/evidence
CMD ["node", "--import", "tsx", "scripts/hosted.ts"]
