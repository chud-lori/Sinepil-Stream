#!/bin/bash
# SinepilStream — manual deploy script
# Run: bash deploy.sh

set -e
cd "$(dirname "$0")"

echo ">>> Pulling latest from GitHub..."
git pull origin main

echo ">>> Installing dependencies..."
npm install --omit=dev

echo ">>> Creating logs dir..."
mkdir -p logs

echo ">>> Restarting app with PM2..."
pm2 restart sinepilstream || pm2 start ecosystem.config.js

echo ">>> Done. Status:"
pm2 status sinepilstream
