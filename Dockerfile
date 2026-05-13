FROM node:20-slim

WORKDIR /app

# Chromium runtime libs for puppeteer's headless-shell binary (used to resolve
# AES-encrypted player tokens from upstream — see lib/headless.js).
# We install only the libs Chromium actually links against; no Chrome browser
# package (puppeteer ships its own pinned chrome-headless-shell).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libc6 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer cache).
# node:20-slim is Debian-based — better-sqlite3 uses its pre-built Linux binary,
# no C++ compilation needed. puppeteer's postinstall downloads chrome-headless-shell
# into ./.cache/puppeteer (configured by .puppeteerrc.cjs).
COPY package*.json .puppeteerrc.cjs ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Create persistent dirs (data is mounted as a volume at runtime)
RUN mkdir -p logs data

EXPOSE 3500

CMD ["node", "server.js"]
