require('dotenv').config();
const Parser = require('rss-parser');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');

// ── Validate .env ─────────────────────────────────────────────────────────────
const REQUIRED = ['GEMINI_API_KEY', 'WP_URL', 'WP_USER', 'WP_APP_PASS'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('\n❌ ERROR: Missing variables in .env:');
  missing.forEach(k => console.error(`   → ${k}`));
  process.exit(1);
}

// ── Init ──────────────────────────────────────────────────────────────────────
const parser = new Parser({ timeout: 15000 });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

const WP_URL      = process.env.WP_URL.replace(/\/$/, '');
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
  'https://feeds.feedburner.com/breitbart',
];

// Keywords to prioritize (articles with these get picked first)
const PRIORITY_KEYWORDS = [
  'trump', 'white house', 'congress', 'senate', 'republican', 'democrat',
  'biden', 'election', 'washington', 'president', 'house of representatives',
  'supreme court', 'maga', 'gop', 'oval office', 'executive order'
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

// ── STEP 1: Fetch from RSS ────────────────────────────────────────────────────
async function fetchLatestArticle() {
  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 8)) {
        if (!postedUrls.has(item.link)) {
          const summary = (item.contentSnippet || item.content || item.summary || '')
            .replace(/<[^>]+>/g, '').substring(0, 2000);
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

// ── STEP 2: Rewrite with Gemini ───────────────────────────────────────────────
async function rewriteWithGemini(article) {
  const prompt = `You are an expert US political journalist and SEO content writer for a news website focused on US politics, Donald Trump, Congress, and Washington DC news.

TASK: Write a COMPLETELY ORIGINAL news article based only on the topic below.
Do NOT copy any sentence. Write as a professional journalist reporting the story yourself.
This content must be 100% unique — safe for Google AdSense approval.

ARTICLE REQUIREMENTS:
- Length: 600-750 words
- Style: clear, factual, engaging, authoritative news tone
- Structure: strong opening paragraph (who/what/when/where), 3-4 body paragraphs with analysis, strong closing
- Use active voice. Never say "According to reports", "It was reported", or "Sources say"
- Write as if YOU witnessed or investigated the story

SEO REQUIREMENTS (very important — must follow exactly):
1. FOCUS KEYPHRASE: 2-4 words, must be the most searched term related to this topic (e.g. "Trump executive order", "Senate vote", "Biden policy")
2. SEO TITLE: 55-60 characters exactly, include focus keyphrase near the beginning
3. SLUG: 4-6 words max, lowercase, hyphens only, include main keyword
4. META DESCRIPTION: 150-160 characters exactly — include focus keyphrase, make it compelling to click
5. Use focus keyphrase in: first sentence of article, at least one H2 heading, and 2-3 more times naturally
6. Use related keywords naturally throughout (synonyms, related terms)

HTML FORMAT:
- Every paragraph: <p>text</p>
- Subheadings: <h2>text</h2> (use 3-4 subheadings)
- Bold key facts: <strong>text</strong> (use 2-3 times)
- No <html>, <body>, <head> tags

TAGS: 5-7 specific tags (people, places, topics mentioned)

Return ONLY raw valid JSON (no markdown, no backticks, nothing before or after):
{"title":"55-60 char SEO title","slug":"focus-keyword-slug","meta_description":"150-160 char meta with keyphrase","focus_keyword":"2-4 word keyphrase","article_html":"<p>...</p><h2>...</h2><p>...</p>","tags":["Trump","Congress","tag3","tag4","tag5"],"category":"US Politics"}

TOPIC TO WRITE ABOUT:
Title: ${article.title}
Summary: ${article.summary}
Source: ${article.source}`;

  const response = await axios.post(GEMINI_URL, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
  }, { timeout: 60000 });

  const raw   = response.data.candidates[0].content.parts[0].text;
  const clean = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (_) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Gemini returned invalid JSON');
  }
}

// ── STEP 3: Fetch ALL categories from WordPress ──────────────────────────────
async function getAllCategoryIds(auth) {
  try {
    const res = await axios.get(
      `${WP_URL}/wp-json/wp/v2/categories?per_page=100`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    // Filter out "Uncategorized" (id=1)
    const cats = res.data.filter(c => c.name !== 'Uncategorized' && c.id !== 1);
    if (cats.length === 0) return [1]; // fallback to Uncategorized
    const names = cats.map(c => c.name).join(', ');
    console.log(`📂 Categories: ${names}`);
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

// ── STEP 5: Post to WordPress ─────────────────────────────────────────────────
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

    console.log('🤖 Rewriting with Gemini AI...');
    const content = await rewriteWithGemini(article);
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
console.log('\n🚀 PolitiPlot Auto-Poster started! (Gemini AI)');
console.log(`🌐 WordPress: ${WP_URL}`);
console.log('⏱️  Posting every 6 hours\n');

runCycle();
setInterval(runCycle, 6 * 60 * 60 * 1000);
