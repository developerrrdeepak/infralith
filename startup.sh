#!/bin/sh
set -e

echo "Starting Infralith on Azure App Service..."

if [ -f ".next/standalone/server.js" ]; then
  echo "Using standalone Next.js server build."
  exec node .next/standalone/server.js
fi

echo "Standalone build not found; falling back to npm start."
exec npm run start
