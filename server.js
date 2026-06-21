require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const BASE_URL = 'https://newsapi.org/v2/everything';

// Queries sent to NewsAPI — edit to change coverage
const QUERIES = [
  'agentic AI banking',
  'AI financial services enterprise',
  'generative AI fintech',
  'AI fraud detection banking',
  'LLM enterprise finance',
  'AI compliance regulation banking',
  'machine learning payments',
];

// Tag detection — keyword sets per topic
const TOPIC_MAP = {
  agentic:    ['agent', 'agentic', 'autonomous', 'multi-agent', 'copilot'],
  banking:    ['bank', 'banking', 'jpmorgan', 'goldman', 'wells fargo', 'citi', 'barclays', 'hsbc', 'fed', 'occ', 'fdic'],
  fintech:    ['fintech', 'payment', 'stripe', 'experian', 'lending', 'credit', 'neobank', 'embedded finance'],
  regulation: ['regulation', 'compliance', 'regulatory', 'sec', 'sr 26-2', 'governance', 'audit', 'kyc', 'aml'],
  fraud:      ['fraud', 'detection', 'risk', 'security', 'threat', 'scam'],
  llm:        ['llm', 'large language model', 'gpt', 'claude', 'gemini', 'foundation model', 'generative ai'],
};

// Minimum relevance score to include an article (0 = include all)
const MIN_SCORE = 1;

function tagArticle(article) {
  const text = `${article.title} ${article.description || ''}`.toLowerCase();
  const tags = [];
  let score = 0;
  for (const [tag, keywords] of Object.entries(TOPIC_MAP)) {
    if (keywords.some(k => text.includes(k))) {
      tags.push(tag);
      score++;
    }
  }
  return { ...article, tags, score };
}

// Simple in-memory cache: refresh at most once per 15 minutes
let cache = { articles: [], updatedAt: null };
const CACHE_TTL_MS = 15 * 60 * 1000;

async function fetchNews() {
  if (cache.updatedAt && Date.now() - new Date(cache.updatedAt).getTime() < CACHE_TTL_MS) {
    return cache;
  }

  const results = await Promise.allSettled(
    QUERIES.map(q =>
      axios.get(BASE_URL, {
        params: { q, apiKey: NEWSAPI_KEY, sortBy: 'publishedAt', language: 'en', pageSize: 20 },
        timeout: 8000,
      })
    )
  );

  const seen = new Set();
  const articles = [];

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const article of r.value.data.articles || []) {
      if (seen.has(article.url) || article.title === '[Removed]') continue;
      seen.add(article.url);
      const tagged = tagArticle(article);
      if (tagged.score >= MIN_SCORE) articles.push(tagged);
    }
  }

  articles.sort((a, b) => b.score - a.score || new Date(b.publishedAt) - new Date(a.publishedAt));

  cache = { articles, updatedAt: new Date().toISOString() };
  return cache;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/news', async (req, res) => {
  if (!NEWSAPI_KEY) {
    return res.status(500).json({ error: 'NEWSAPI_KEY not set. Add it to your .env file.' });
  }
  try {
    const data = await fetchNews();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Allow manual cache flush
app.post('/api/refresh', async (req, res) => {
  cache = { articles: [], updatedAt: null };
  try {
    const data = await fetchNews();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  AI & Fintech Feed → http://localhost:${PORT}\n`);
});
