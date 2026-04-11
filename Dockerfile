FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Create logs dir
RUN mkdir -p logs

EXPOSE 3500

CMD ["node", "server.js"]
