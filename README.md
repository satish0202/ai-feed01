# AI Feed 01

A lightweight Node.js app that aggregates AI, agentic systems, and banking/fintech news into a live browser feed — powered by [NewsAPI](https://newsapi.org).

## Features

- Cards with headline, source, time, excerpt, and topic tags
- Filter by: **Agentic AI · Banking · Fintech · Regulation · Fraud/Risk · LLM/Models**
- Auto-refreshes every 15 minutes with live countdown
- Manual refresh button
- Relevance scoring — highest-signal articles surface first

## Setup

```bash
git clone https://github.com/satish0202/ai-feed01
cd ai-feed01
npm install
cp .env.example .env
# Add your NewsAPI key to .env
npm start
```

Open `http://localhost:3000`

## Configuration

Edit `server.js` to customise:

- `QUERIES` — search terms sent to NewsAPI
- `TOPIC_MAP` — keywords that control tag assignment
- `MIN_SCORE` — minimum relevance score to display an article (0 = show all)
- `CACHE_TTL_MS` — how long to cache results before re-fetching

## Get a NewsAPI key

Sign up free at [newsapi.org](https://newsapi.org) — the free tier covers development use.
