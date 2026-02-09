# Bird League API

Backend for Bird League Season 1 — an AI-judged bird competition.

## Quick Start

```bash
# Seed the database with Week 1 & 2 data
npm run seed

# Start the server
npm start
```

Server runs on port 3001 (or `PORT` env var).

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3001) |
| `ALLOWED_ORIGINS` | Yes (prod) | Comma-separated frontend URLs for CORS |
| `ADMIN_SECRET` | Yes | Secret for admin endpoints (judging, reset) |
| `OPENAI_API_KEY` | For judging | ChatGPT API key |
| `GOOGLE_AI_API_KEY` | For judging | Gemini API key |
| `ANTHROPIC_API_KEY` | For judging | Claude API key |

## Submitting a bird (JSON)

```bash
curl -X POST http://localhost:3001/api/submit/3/1 \
  -H "Content-Type: application/json" \
  -d '{"species":"Bald Eagle","description":"Spotted over the river"}'
```

Admin endpoints require `Authorization: Bearer YOUR_ADMIN_SECRET` header.
