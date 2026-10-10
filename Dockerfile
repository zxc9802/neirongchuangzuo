FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY services/digital-human/package*.json ./services/digital-human/
RUN npm ci --prefix services/digital-human --include=dev
COPY package.json package-lock.json preview.mjs ./
RUN npm ci --include=dev
COPY scripts ./scripts
COPY design ./design
COPY services ./services
RUN node scripts/setup-restaurant-model.mjs
RUN npm run build

FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=8080 NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl fonts-noto-cjk python3 python3-venv \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 \
    libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 \
    libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app /app
RUN python3 -m venv /opt/mix-venv \
    && /opt/mix-venv/bin/pip install --no-cache-dir -r services/mix/python/requirements.txt
ENV MIX_PYTHON_BIN=/opt/mix-venv/bin/python
WORKDIR /app/services/digital-human
RUN npx remotion browser ensure
RUN mkdir -p .runtime/jobs .runtime/uploads .runtime/provider-input .runtime/state
WORKDIR /app
RUN mkdir -p .data/ai
VOLUME ["/app/.data", "/app/services/digital-human/.runtime"]
EXPOSE 8080
CMD ["node", "scripts/start.mjs"]
