# Infralith

AI-powered construction intelligence platform built with Next.js. It combines blueprint analysis, compliance checks, risk insights, collaboration, and reporting workflows.

## Tech Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS + Radix UI
- Azure OpenAI, Azure Document Intelligence, Azure AI Search, Azure Cosmos DB

## Quick Start

1. Install dependencies:
   `npm install`
2. Create local environment file:
   `cp .env.example .env.local`
3. Start dev server:
   `npm run dev`
4. Open:
   `http://localhost:3500`

## Scripts

- `npm run dev` - start local development server
- `npm run build` - production build
- `npm run start` - run the production server after `npm run build`
- `npm run lint` - TypeScript type check
- `npm run typecheck` - TypeScript type check

## Environment

Use `.env.example` as the source of truth for required keys.

Main groups:
- Auth and access control
- Azure OpenAI
- Azure Document Intelligence
- Azure AI Search
- Azure Cosmos DB
- Optional external integrations

## Project Structure

- `src/app` - routes and API endpoints
- `src/components` - UI and feature components
- `src/ai` - AI orchestration flows and model integrations
- `src/lib` - shared services and utilities
- `src/contexts` - app-wide state providers
- `docs` - setup guides and research notes

## Documentation

See [docs/README.md](docs/README.md) for a full guide index.

## Security Notes

- Do not commit real secrets, publish profiles, logs, or generated artifacts.
- Keep `.env.local` local-only; commit only `.env.example`.
