require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const Parser    = require('rss-parser');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');

// ── Validate .env before starting ────────────────────────────────────────────
const REQUIRED = ['ANTHROPIC_API_KEY', 'WP_URL', 'WP_USER', 'WP_APP_PASS'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('\n❌ ERROR: Missing variables in .env file:');
  missing.forEach(k => console.error(`   → ${k}`));
  console.error('\n📖 Open README.md and follow setup steps.\n');
  process.exit(1);
}

// ── Init ──────────────────────────────────────────────────────────────────────
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const parser = new Parser({ timeout: 15000 });

const WP_URL      = process.env.WP_URL.replace(/\/$/, '');
const WP_USER     = process.env.WP_USER;
const WP_PASSWORD = process.env.WP_APP_PASS;

// ── RSS Feeds — US Political News ─────────────────────────────────────────────
const RSS_FEEDS = [
  'https://feeds.reuters.com/reuters/politicsNews',
  'https://rss.politico.com/politics-news.xml',
  'https://feeds.npr.org/1014/rss.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml',
  'https://feeds.washingtonpost.com/rss/politics',
  'https://thehill.com/rss/syndicator/19109',
  'https://www.cbsnews.com/latest/rss/politics',
];

// ── Persistent dedup: save posted URLs to disk so restarts don't repost ───────
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
    const arr = [...set].slice(-500); // keep last 500 only
    fs.writeFileSync(POSTED_FILE, JSON.stringify(arr), 'utf8');
  } catch (e) { console.warn('Could not save posted.json:', e.message); }
}

const postedUrls = loadPosted();
console.log(`📂 Loaded ${postedUrls.size} previously posted URLs.`);

// ── STEP 1: Get newest unposted article from RSS ──────────────────────────────
async function fetchLatestArticle() {
  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 8)) {
        if (!postedUrls.has(item.link)) {
          const summary = (item.contentSnippet || item.content || item.summary || item.description || '')
            .replace(/<[^>]+>/g, '')
            .substring(0, 2000);
          console.log(`📰 Found: ${item.title}`);
          return { title: item.title, url: item.link, summary, source: feed.title };
        }
      }
    } catch (e) {
      console.warn(`⚠️ RSS failed (${feedUrl}): ${e.message}`);
    }
  }
  return null;
}

// ── STEP 2: Rewrite 100% original with Claude ─────────────────────────────────
async function rewriteWithClaude(article) {
  const prompt = `You are an expert US political journalist and SEO content writer.

TASK: Write a COMPLETELY ORIGINAL news article based only on the topic below.
Do NOT copy any sentence from the source. Write as a professional journalist.

REQUIREMENTS:
- Length: 550-700 words
- Style: clear, factual, engaging, professional news tone
- Structure: strong opening paragraph, 3-4 body paragraphs, closing paragraph
- Use active voice. Do NOT say "According to reports" or "It was reported"

SEO:
- Extract a 1-3 word focus keyword from the topic
- Use keyword in: first paragraph, at least one H2, and 2-3 times in body
- Title: 55-60 characters, compelling, keyword near the start
- Meta description: exactly 150-160 characters, includes keyword

HTML FORMAT for article_html:
- Wrap every paragraph in <p> tags
- Use <h2> tags for subheadings (3 minimum)
- Do NOT include <html> <body> <head> tags

Return ONLY raw valid JSON (no markdown, no backticks, nothing else):
{"title":"...","slug":"url-slug-max-6-words","meta_description":"...","focus_keyword":"...","article_html":"<p>...</p><h2>...</h2><p>...</p>","tags":["tag1","tag2","tag3"],"category":"US Politics"}

TOPIC:
Title: ${article.title}
Summary: ${article.summary}
Source: ${article.source}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
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

// ── STEP 3: Get or create category ───────────────────────────────────────────
async function getOrCreateCategory(name, auth) {
  try {
    const res = await axios.get(`${WP_URL}/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Basic ${auth}` } });
    if (res.data.length > 0) return res.data[0].id;
    const created = await axios.post(`${WP_URL}/wp-json/wp/v2/categories`, { name },
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } });
    return created.data.id;
  } catch (e) { console.warn('Category error:', e.message); return null; }
}

// ── STEP 4: Get or create tags ────────────────────────────────────────────────
async function getOrCreateTags(tags, auth) {
  const ids = [];
  for (const tagName of (tags || [])) {
    try {
      const res = await axios.get(`${WP_URL}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}`,
        { headers: { Authorization: `Basic ${auth}` } });
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

  const [tagIds, categoryId] = await Promise.all([
    getOrCreateTags(content.tags, auth),
    getOrCreateCategory(content.category || 'US Politics', auth),
  ]);

  const postData = {
    title:      content.title,
    content:    content.article_html,
    slug:       content.slug,
    status:     'publish',
    excerpt:    content.meta_description,
    tags:       tagIds,
    categories: categoryId ? [categoryId] : [],
    meta: {
      _yoast_wpseo_title:      content.title,
      _yoast_wpseo_metadesc:   content.meta_description,
      _yoast_wpseo_focuskw:    content.focus_keyword,
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
    console.log(`🔑 Keyword: ${content.focus_keyword}`);

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
console.log('\n🚀 PolitiPlot Auto-Poster started!');
console.log(`🌐 WordPress: ${WP_URL}`);
console.log('⏱️  Posting every 1 hour\n');

runCycle();
setInterval(runCycle, 60 * 60 * 1000);
