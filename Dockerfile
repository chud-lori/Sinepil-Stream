FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Create persistent dirs (data is mounted as a volume at runtime)
RUN mkdir -p logs data

EXPOSE 3500

CMD ["node", "server.js"]
