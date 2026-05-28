#!/bin/bash
set -e
cd bot
echo "[start] Installing bot dependencies..."
npm install --production
echo "[start] Starting server..."
exec node server.js
