FROM node:20-alpine

WORKDIR /app

# Build tools required to compile native addons (better-sqlite3 uses node-gyp)
RUN apk add --no-cache python3 make g++

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Remove build tools after compilation to keep the image lean
RUN apk del python3 make g++

# Copy source
COPY . .

# Create persistent dirs (data is mounted as a volume at runtime)
RUN mkdir -p logs data

EXPOSE 3500

CMD ["node", "server.js"]
