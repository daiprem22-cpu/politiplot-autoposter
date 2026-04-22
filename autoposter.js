require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const Parser    = require('rss-parser');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');

// ── Validate .env ─────────────────────────────────────────────────────────────
const REQUIRED = ['ANTHROPIC_API_KEY', 'WP_URL', 'WP_USER', 'WP_APP_PASS'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('\n❌ ERROR: Missing variables in .env:');
  missing.forEach(k => console.error(`   → ${k}`));
  process.exit(1);
}

// ── Init ──────────────────────────────────────────────────────────────────────
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const parser = new Parser({ timeout: 15000 });

const WP_URL      = process.env.WP_URL.replace(/\/$/, '').replace('/wp-admin', '');
const WP_USER     = process.env.WP_USER;
const WP_PASSWORD = process.env.WP_APP_PASS;

// ── RSS Feeds — US Political News ─────────────────────────────────────────────
const RSS_FEEDS = [
  'https://rss.politico.com/politics-news.xml',
  'https://feeds.npr.org/1014/rss.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',
  'https://feeds.washingtonpost.com/rss/politics',
  'https://thehill.com/rss/syndicator/19109',
  'https://www.cbsnews.com/latest/rss/politics',
  'https://feeds.reuters.com/reuters/politicsNews',
  'https://rss.foxnews.com/fn/politics/feeds/rss/latest',
];

// Priority keywords — Trump/US politics first
const PRIORITY_KEYWORDS = [
  'trump', 'white house', 'congress', 'senate', 'republican', 'democrat',
  'biden', 'election', 'washington', 'president', 'house of representatives',
  'supreme court', 'maga', 'gop', 'oval office', 'executive order',
  'tariff', 'immigration', 'border', 'federal', 'policy', 'vote', 'bill',
];

// ── Persistent dedup ──────────────────────────────────────────────────────────
const POSTED_FILE = path.join(__dirname, 'posted.json');

function loadPosted() {
  try {
    if (fs.existsSync(POSTED_FILE))
      return new Set(JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8')));
  } catch (_) {}
  return new Set();
}

function savePosted(set) {
  try {
    fs.writeFileSync(POSTED_FILE, JSON.stringify([...set].slice(-500)), 'utf8');
  } catch (e) { console.warn('Could not save posted.json:', e.message); }
}

const postedUrls = loadPosted();
console.log(`📂 Loaded ${postedUrls.size} previously posted URLs.`);

// ── STEP 1: Fetch from RSS — priority: Trump/US politics ──────────────────────
async function fetchLatestArticle() {
  const allArticles = [];

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 10)) {
        if (!postedUrls.has(item.link)) {
          const summary = (item.contentSnippet || item.content || item.summary || '')
            .replace(/<[^>]+>/g, '').substring(0, 2000);
          const titleLower = (item.title || '').toLowerCase();
          const isPriority = PRIORITY_KEYWORDS.some(kw => titleLower.includes(kw));
          allArticles.push({
            title: item.title, url: item.link, summary,
            source: feed.title, priority: isPriority ? 1 : 0,
          });
        }
      }
    } catch (e) {
      console.warn(`⚠️ RSS failed (${feedUrl}): ${e.message}`);
    }
  }

  if (allArticles.length === 0) return null;

  // Priority articles first
  allArticles.sort((a, b) => b.priority - a.priority);
  const article = allArticles[0];
  console.log(`📰 Found${article.priority ? ' 🔥' : ''}: ${article.title}`);
  return article;
}

// ── STEP 2: Rewrite 100% original with Claude ─────────────────────────────────
async function rewriteWithClaude(article) {
  const prompt = `You are an expert US political journalist and SEO content writer for a news website focused on US politics, Donald Trump, Congress, and Washington DC news.

TASK: Write a COMPLETELY ORIGINAL news article based only on the topic below.
Do NOT copy any sentence. Write as a professional journalist reporting the story.
This content must be 100% unique — safe for Google AdSense approval.

ARTICLE REQUIREMENTS:
- Length: 600-750 words
- Style: clear, factual, engaging, authoritative news tone
- Structure: strong opening paragraph (who/what/when/where), 3-4 body paragraphs with context and analysis, strong closing
- Use active voice. Never say "According to reports" or "It was reported"
- Write as if YOU investigated the story

SEO REQUIREMENTS (follow exactly):
1. FOCUS KEYPHRASE: 2-4 words, the most searched term for this topic (e.g. "Trump executive order", "Senate vote 2025")
2. SEO TITLE: exactly 55-60 characters, include focus keyphrase near the beginning, make it compelling
3. SLUG: 4-6 words, lowercase, hyphens only, include main keyword
4. META DESCRIPTION: exactly 150-160 characters, include focus keyphrase, make people want to click
5. Use focus keyphrase in: first sentence, at least one H2, and 2-3 more times naturally in body
6. Use related keywords naturally (synonyms, related terms)

HTML FORMAT for article_html:
- Every paragraph: <p>text</p>
- Subheadings: <h2>text</h2> (use 3-4 subheadings, include keyphrase in at least one)
- Bold key facts: <strong>text</strong> (2-3 times)
- No <html>, <body>, <head> tags

TAGS: 5-7 specific tags (names of people, places, topics in the article)

Return ONLY raw valid JSON (no markdown, no backticks, nothing before or after the JSON):
{"title":"55-60 char SEO title here","slug":"keyword-slug-here","meta_description":"150-160 char meta description here","focus_keyword":"2-4 word keyphrase","article_html":"<p>Full article HTML...</p>","tags":["Trump","Congress","tag3","tag4","tag5"],"category":"US Politics"}

TOPIC:
Title: ${article.title}
Summary: ${article.summary}
Source: ${article.source}`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw   = message.content.map(b => b.text || '').join('');
  const clean = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (_) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned invalid JSON');
  }
}

// ── STEP 3: Get ALL categories from WordPress ─────────────────────────────────
async function getAllCategoryIds(auth) {
  try {
    const res = await axios.get(
      `${WP_URL}/wp-json/wp/v2/categories?per_page=100`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const cats = res.data.filter(c => c.name !== 'Uncategorized' && c.id !== 1);
    if (cats.length === 0) return [1];
    console.log(`📂 Categories (${cats.length}): ${cats.map(c => c.name).join(', ')}`);
    return cats.map(c => c.id);
  } catch (e) {
    console.warn('Category error:', e.message);
    return [];
  }
}

// ── STEP 4: Get or create tags ────────────────────────────────────────────────
async function getOrCreateTags(tags, auth) {
  const ids = [];
  for (const tagName of (tags || [])) {
    try {
      const res = await axios.get(
        `${WP_URL}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      if (res.data.length > 0) { ids.push(res.data[0].id); continue; }
      const created = await axios.post(`${WP_URL}/wp-json/wp/v2/tags`, { name: tagName },
        { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } });
      ids.push(created.data.id);
    } catch (e) { console.warn(`Tag error (${tagName}):`, e.message); }
  }
  return ids;
}

// ── STEP 5: Post to WordPress REST API ───────────────────────────────────────
async function postToWordPress(content) {
  const auth = Buffer.from(`${WP_USER}:${WP_PASSWORD}`).toString('base64');

  const [tagIds, allCategoryIds] = await Promise.all([
    getOrCreateTags(content.tags, auth),
    getAllCategoryIds(auth),
  ]);

  const postData = {
    title:      content.title,
    content:    content.article_html,
    slug:       content.slug,
    status:     'publish',
    excerpt:    content.meta_description,
    tags:       tagIds,
    categories: allCategoryIds,
    meta: {
      // Yoast SEO
      _yoast_wpseo_title:      content.title,
      _yoast_wpseo_metadesc:   content.meta_description,
      _yoast_wpseo_focuskw:    content.focus_keyword,
      // Rank Math SEO
      rank_math_focus_keyword: content.focus_keyword,
      rank_math_description:   content.meta_description,
      rank_math_title:         content.title,
    },
  };

  const response = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, postData, {
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  return response.data;
}

// ── MAIN CYCLE ────────────────────────────────────────────────────────────────
async function runCycle() {
  console.log(`\n🕐 ${new Date().toLocaleString()} — Starting cycle...`);
  try {
    const article = await fetchLatestArticle();
    if (!article) { console.log('ℹ️  No new articles. Waiting...'); return; }

    console.log('🤖 Rewriting with Claude AI...');
    const content = await rewriteWithClaude(article);
    console.log(`✅ Written: "${content.title}"`);
    console.log(`🔑 Focus Keyphrase: ${content.focus_keyword}`);
    console.log(`🔗 Slug: ${content.slug}`);
    console.log(`📋 Meta: ${content.meta_description}`);

    console.log('📤 Posting to WordPress...');
    const post = await postToWordPress(content);
    console.log(`🎉 Published! → ${post.link}`);

    postedUrls.add(article.url);
    savePosted(postedUrls);

  } catch (err) {
    if (err.response)
      console.error(`❌ HTTP ${err.response.status}:`, JSON.stringify(err.response.data).substring(0, 300));
    else
      console.error('❌ Error:', err.message);
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log('\n🚀 PolitiPlot Auto-Poster started! (Claude AI)');
console.log(`🌐 WordPress: ${WP_URL}`);
console.log('⏱️  Posting every 1 hour\n');

runCycle();
setInterval(runCycle, 60 * 60 * 1000);
