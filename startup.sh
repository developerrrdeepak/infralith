#!/bin/sh
set -eu

echo "Starting Infralith on Azure App Service..."

if [ -f "server.js" ]; then
  echo "Using packaged standalone server from deployment root."
  exec node server.js
fi

if [ -f ".next/standalone/server.js" ]; then
  # Make sure standalone server can serve framework/static and public assets.
  if [ -d ".next/static" ]; then
    mkdir -p ".next/standalone/.next"
    rm -rf ".next/standalone/.next/static"
    cp -r ".next/static" ".next/standalone/.next/static"
  fi

  if [ -d "public" ]; then
    rm -rf ".next/standalone/public"
    cp -r "public" ".next/standalone/public"
  fi

  echo "Using standalone Next.js server build."
  exec node .next/standalone/server.js
fi

echo "Standalone build not found; falling back to npm start."
exec npm run start
