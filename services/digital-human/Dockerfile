# Stage 1: Dependencies & Build
FROM public.ecr.aws/docker/library/node:20-bookworm-slim AS builder

WORKDIR /app

# Install all build dependencies
COPY package*.json ./
RUN npm ci --include=dev

# Copy project files
COPY . .

# Build Next.js
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 2: Production Runner
FROM public.ecr.aws/docker/library/node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV NEXT_TELEMETRY_DISABLED=1

# Install runtime ffmpeg and ffprobe (Essential for video/audio processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    fonts-noto-cjk libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 \
    libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 \
    libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*

# Copy package and production node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/.motion-bundle ./.motion-bundle
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src

RUN npx remotion browser ensure

# Create private runtime directories
RUN mkdir -p /app/.runtime/jobs /app/.runtime/uploads /app/.runtime/provider-input

EXPOSE 3000

CMD ["npm", "run", "start"]
