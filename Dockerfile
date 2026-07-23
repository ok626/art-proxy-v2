# ---- deps + build stage --------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# sharp needs build tooling available for native deps on some platforms
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Needed for the poster info bar's text rendering (genre/rating), which
# sharp renders via librsvg. Roboto is the primary font (matches the
# clean, modern look most streaming-app UIs use); DejaVu is kept as a
# fallback in case Roboto is ever unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-roboto fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||7777)+'/healthz', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
