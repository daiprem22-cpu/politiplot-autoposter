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

// Rotation index — which category to post next
const ROTATION_FILE = path.join(__dirname, 'rotation.json');
function loadRotation() {
  try {
    if (fs.existsSync(ROTATION_FILE))
      return JSON.parse(fs.readFileSync(ROTATION_FILE, 'utf8')).index || 0;
  } catch (_) {}
  return 0;
}
function saveRotation(index) {
  try {
    fs.writeFileSync(ROTATION_FILE, JSON.stringify({ index }), 'utf8');
  } catch (_) {}
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
    model:      'claude-sonnet-4-5',
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

// ── STEP 4: Upload featured image from Unsplash (free, no API key) ───────────
// ── Detect political figure from title/keyword ───────────────────────────────
function detectPolitician(title, keyword) {
  const text = (title + ' ' + keyword).toLowerCase();
  const politicians = [
    { name: 'Donald Trump',      terms: ['trump', 'donald trump'] },
    { name: 'Joe Biden',         terms: ['biden', 'joe biden'] },
    { name: 'Kamala Harris',     terms: ['kamala', 'harris'] },
    { name: 'Barack Obama',      terms: ['obama', 'barack obama'] },
    { name: 'Nancy Pelosi',      terms: ['pelosi', 'nancy pelosi'] },
    { name: 'Mike Pence',        terms: ['pence', 'mike pence'] },
    { name: 'Ron DeSantis',      terms: ['desantis', 'ron desantis'] },
    { name: 'Elon Musk',         terms: ['elon musk', 'musk'] },
    { name: 'Nikki Haley',       terms: ['nikki haley', 'haley'] },
    { name: 'Bernie Sanders',    terms: ['bernie', 'sanders'] },
    { name: 'Chuck Schumer',     terms: ['schumer', 'chuck schumer'] },
    { name: 'Mitch McConnell',   terms: ['mcconnell', 'mitch mcconnell'] },
    { name: 'Alexandria Ocasio', terms: ['aoc', 'ocasio-cortez', 'alexandria ocasio'] },
    { name: 'Marco Rubio',       terms: ['rubio', 'marco rubio'] },
    { name: 'Ted Cruz',          terms: ['ted cruz', 'cruz'] },
  ];
  for (const p of politicians) {
    if (p.terms.some(t => text.includes(t))) return p.name;
  }
  return null;
}

async function uploadFeaturedImage(keyword, categoryName, articleTitle, auth) {
  const categoryImageTerms = {
    'Politics':      'politician government washington dc',
    'Business':      'wall street stock market business finance',
    'Entertainment': 'hollywood entertainment cinema red carpet',
    'Sports':        'sports stadium athlete competition',
    'Technology':    'technology computer silicon valley innovation',
    'World News':    'world globe international diplomacy',
    'US News':       'american flag united states city',
  };

  // For Politics: detect politician and use their name as search term
  let searchTerm;
  if (categoryName === 'Politics') {
    const politician = detectPolitician(articleTitle, keyword);
    if (politician) {
      searchTerm = politician + ' politician';
      console.log(`👤 Detected politician: ${politician}`);
    } else {
      searchTerm = keyword + ' washington dc politics';
    }
  } else {
    searchTerm = keyword + ' ' + (categoryImageTerms[categoryName] || 'news');
  }

  console.log(`🔍 Image search: "${searchTerm}"`);

  const sources = [
    `https://loremflickr.com/1200/630/${encodeURIComponent(searchTerm.split(' ').slice(0,3).join(','))}`,
    `https://loremflickr.com/1200/630/${encodeURIComponent(categoryImageTerms[categoryName] || 'politics')}`,
    `https://picsum.photos/seed/${encodeURIComponent(searchTerm)}/1200/630`,
  ];

  for (const imageUrl of sources) {
    try {
      const imgResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxRedirects: 5,
      });

      const buffer   = Buffer.from(imgResponse.data);
      const filename = keyword.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '-' + Date.now() + '.jpg';
      const FormData = require('form-data');
      const form     = new FormData();
      form.append('file', buffer, { filename, contentType: 'image/jpeg' });

      const uploadRes = await axios.post(`${WP_URL}/wp-json/wp/v2/media`, form, {
        headers: { ...form.getHeaders(), Authorization: `Basic ${auth}` },
        timeout: 30000,
      });

      // SEO: alt text = politician name or keyword, caption = full context
      const altText = categoryName === 'Politics' && detectPolitician(articleTitle, keyword)
        ? detectPolitician(articleTitle, keyword) + ' - ' + keyword
        : keyword;

      await axios.post(`${WP_URL}/wp-json/wp/v2/media/${uploadRes.data.id}`, {
        alt_text: altText,
        caption:  altText + ' | ' + categoryName,
        title:    keyword,
      }, {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      }).catch(() => {});

      console.log(`🖼️  Image uploaded OK`);
      return uploadRes.data.id;
    } catch (e) {
      console.warn(`⚠️ Image source failed: ${e.message}`);
    }
  }

  console.warn('⚠️ All image sources failed — posting without image.');
  return null;
}

// ── STEP 5: Get or create tags ────────────────────────────────────────────────
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

// ── STEP 6: Post to WordPress REST API ───────────────────────────────────────
async function postToWordPress(content) {
  const auth = Buffer.from(`${WP_USER}:${WP_PASSWORD}`).toString('base64');

  const [tagIds, allCategoryIds, featuredImageId] = await Promise.all([
    getOrCreateTags(content.tags, auth),
    getAllCategoryIds(auth),
    uploadFeaturedImage(content.focus_keyword, auth),
  ]);

  const postData = {
    title:          content.title,
    content:        content.article_html,
    slug:           content.slug,
    status:         'publish',
    excerpt:        content.meta_description,
    tags:           tagIds,
    categories:     allCategoryIds,
    featured_media: featuredImageId || 0,
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

// ── Category definitions with RSS + topics ───────────────────────────────────
const CATEGORIES_CONFIG = [
  {
    name: 'Politics',
    topic: 'US politics, Donald Trump, Congress, Senate, White House, elections, GOP, Democrats',
    rss: ['https://rss.politico.com/politics-news.xml', 'https://thehill.com/rss/syndicator/19109'],
    keywords: ['trump', 'congress', 'senate', 'white house', 'republican', 'democrat', 'election', 'gop', 'maga', 'oval office', 'executive order', 'president'],
  },
  {
    name: 'Business',
    topic: 'US economy, Wall Street, stock market, tariffs, trade, Federal Reserve, inflation, companies',
    rss: ['https://feeds.reuters.com/reuters/businessNews', 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml'],
    keywords: ['economy', 'stock', 'market', 'tariff', 'trade', 'federal reserve', 'inflation', 'business', 'wall street', 'gdp', 'recession', 'jobs', 'unemployment'],
  },
  {
    name: 'Entertainment',
    topic: 'Hollywood movies, celebrities, music, TV shows, awards, pop culture, Netflix',
    rss: ['https://feeds.reuters.com/reuters/entertainment', 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml'],
    keywords: ['movie', 'film', 'celebrity', 'hollywood', 'music', 'award', 'oscar', 'grammy', 'netflix', 'disney', 'show', 'actor', 'singer'],
  },
  {
    name: 'Sports',
    topic: 'NFL, NBA, MLB, NHL, soccer, US sports news, athletes, championships',
    rss: ['https://feeds.reuters.com/reuters/sportsNews', 'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml'],
    keywords: ['nfl', 'nba', 'mlb', 'nhl', 'football', 'basketball', 'baseball', 'soccer', 'sport', 'game', 'player', 'team', 'championship', 'league'],
  },
  {
    name: 'Technology',
    topic: 'AI, Silicon Valley, tech companies, Apple, Google, Meta, Microsoft, startups, innovation',
    rss: ['https://feeds.reuters.com/reuters/technologyNews', 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml'],
    keywords: ['ai', 'tech', 'apple', 'google', 'meta', 'microsoft', 'openai', 'silicon valley', 'startup', 'software', 'app', 'robot', 'data', 'cyber'],
  },
  {
    name: 'World News',
    topic: 'International news, foreign policy, global conflicts, diplomacy, NATO, Europe, Asia',
    rss: ['https://feeds.reuters.com/reuters/worldNews', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'],
    keywords: ['war', 'nato', 'europe', 'china', 'russia', 'ukraine', 'middle east', 'iran', 'israel', 'united nations', 'foreign', 'global', 'international', 'sanctions'],
  },
  {
    name: 'US News',
    topic: 'US domestic news, American society, crime, education, health, environment, infrastructure',
    rss: ['https://feeds.npr.org/1003/rss.xml', 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml'],
    keywords: ['american', 'usa', 'united states', 'crime', 'education', 'health', 'environment', 'community', 'local', 'state', 'federal', 'infrastructure', 'housing', 'immigration'],
  },
];

// ── Fetch article for a specific category ─────────────────────────────────────
async function fetchArticleForCategory(catConfig) {
  const allArticles = [];

  for (const feedUrl of catConfig.rss) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 10)) {
        if (!postedUrls.has(item.link)) {
          const summary = (item.contentSnippet || item.content || item.summary || '')
            .replace(/<[^>]+>/g, '').substring(0, 2000);
          const titleLower = (item.title || '').toLowerCase();
          const isMatch = catConfig.keywords.some(kw => titleLower.includes(kw));
          allArticles.push({ title: item.title, url: item.link, summary, source: feed.title, match: isMatch ? 1 : 0 });
        }
      }
    } catch (e) {
      console.warn(`⚠️ RSS failed (${feedUrl}): ${e.message}`);
    }
  }

  // Also check general feeds
  const generalFeeds = [
    'https://feeds.npr.org/1014/rss.xml',
    'https://feeds.washingtonpost.com/rss/politics',
    'https://www.cbsnews.com/latest/rss/politics',
  ];
  for (const feedUrl of generalFeeds) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 8)) {
        if (!postedUrls.has(item.link)) {
          const summary = (item.contentSnippet || item.content || item.summary || '')
            .replace(/<[^>]+>/g, '').substring(0, 2000);
          const titleLower = (item.title || '').toLowerCase();
          const isMatch = catConfig.keywords.some(kw => titleLower.includes(kw));
          if (isMatch) allArticles.push({ title: item.title, url: item.link, summary, source: feed.title, match: 1 });
        }
      }
    } catch (_) {}
  }

  if (allArticles.length === 0) return null;
  allArticles.sort((a, b) => b.match - a.match);
  return allArticles[0];
}

// ── Rewrite for specific category ─────────────────────────────────────────────
async function rewriteForCategory(article, catConfig) {
  const prompt = `You are an expert journalist and SEO content writer specializing in: ${catConfig.topic}.

TASK: Write a COMPLETELY ORIGINAL news article based only on the topic below.
Do NOT copy any sentence. Write as a professional journalist.
This content must be 100% unique — safe for Google AdSense approval.

ARTICLE REQUIREMENTS:
- Length: 600-750 words
- Style: clear, factual, engaging, authoritative news tone
- Category focus: ${catConfig.name} — write from this angle specifically
- Structure: strong opening (who/what/when/where), 3-4 body paragraphs, strong closing
- Use active voice. Never say "According to reports" or "It was reported"

SEO REQUIREMENTS (follow exactly):
1. FOCUS KEYPHRASE: 2-4 words, most searched term for this topic
2. SEO TITLE: exactly 55-60 characters, include keyphrase near start
3. SLUG: 4-6 words, lowercase, hyphens only
4. META DESCRIPTION: exactly 150-160 characters, include keyphrase, compelling to click
5. Use keyphrase in: first sentence, at least one H2, and 2-3 more times naturally

HTML FORMAT:
- Every paragraph: <p>text</p>
- Subheadings: <h2>text</h2> (3-4 minimum, keyphrase in at least one)
- Bold key facts: <strong>text</strong> (2-3 times)
- No <html>, <body>, <head> tags

TAGS: 5-7 specific tags relevant to ${catConfig.name}

Return ONLY raw valid JSON (no markdown, no backticks):
{"title":"55-60 char SEO title","slug":"keyword-slug","meta_description":"150-160 char meta","focus_keyword":"2-4 word keyphrase","article_html":"<p>...</p><h2>...</h2><p>...</p>","tags":["tag1","tag2","tag3","tag4","tag5"],"category":"${catConfig.name}"}

TOPIC:
Title: ${article.title}
Summary: ${article.summary}
Source: ${article.source}`;

  const message = await client.messages.create({
    model:      'claude-sonnet-4-5',
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

// ── Get category ID by name ───────────────────────────────────────────────────
async function getCategoryIdByName(name, auth) {
  try {
    const res = await axios.get(
      `${WP_URL}/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}&per_page=10`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const found = res.data.find(c => c.name.toLowerCase() === name.toLowerCase());
    return found ? found.id : null;
  } catch (e) { console.warn('Category ID error:', e.message); return null; }
}

// ── MAIN CYCLE — post ONE article per hour, rotating through categories ─────
async function runCycle() {
  console.log(`\n🕐 ${new Date().toLocaleString()} — Starting cycle...`);

  const auth = Buffer.from(`${WP_USER}:${WP_PASSWORD}`).toString('base64');

  // Get current category by rotation
  const rotIndex = loadRotation();
  const CATEGORIES_CONFIG_WRAP = CATEGORIES_CONFIG;
  const currentIndex = rotIndex % CATEGORIES_CONFIG_WRAP.length;
  const nextIndex = (currentIndex + 1) % CATEGORIES_CONFIG_WRAP.length;

  // Post only for current category
  const categoriesThisCycle = [CATEGORIES_CONFIG_WRAP[currentIndex]];
  console.log(`🔄 Rotation ${currentIndex + 1}/${CATEGORIES_CONFIG_WRAP.length}: ${categoriesThisCycle[0].name}\n`);

  let published = 0;

  for (const catConfig of categoriesThisCycle) {
    console.log(`\n━━━ ${catConfig.name.toUpperCase()} ━━━`);
    try {
      // 1. Fetch article for this category
      const article = await fetchArticleForCategory(catConfig);
      if (!article) { console.log(`ℹ️  No article found for ${catConfig.name}`); continue; }
      console.log(`📰 Found: ${article.title}`);

      // 2. Rewrite with Claude for this category
      console.log(`🤖 Rewriting for ${catConfig.name}...`);
      const content = await rewriteForCategory(article, catConfig);
      console.log(`✅ "${content.title}"`);
      console.log(`🔑 ${content.focus_keyword}`);

      // 3. Get category ID
      const categoryId = await getCategoryIdByName(catConfig.name, auth);

      // 4. Upload image
      const imageId = await uploadFeaturedImage(content.focus_keyword, catConfig.name, content.title, auth);

      // 5. Post to WordPress in THIS category only
      const [tagIds] = await Promise.all([getOrCreateTags(content.tags, auth)]);

      const postData = {
        title:          content.title,
        content:        content.article_html,
        slug:           content.slug,
        status:         'publish',
        excerpt:        content.meta_description,
        tags:           tagIds,
        categories:     categoryId ? [categoryId] : [],
        featured_media: imageId || 0,
        // Yoast SEO fields (via PolitiPlot SEO REST API plugin)
        yoast_title:    content.title,
        yoast_metadesc: content.meta_description,
        yoast_focuskw:  content.focus_keyword,
      };

      const response = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, postData, {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      });

      console.log(`🎉 Published in [${catConfig.name}] → ${response.data.link}`);
      postedUrls.add(article.url);
      published++;

      // Small delay between posts to avoid overloading server
      await new Promise(r => setTimeout(r, 3000));

    } catch (err) {
      if (err.response)
        console.error(`❌ [${catConfig.name}] HTTP ${err.response.status}:`, JSON.stringify(err.response.data).substring(0, 200));
      else
        console.error(`❌ [${catConfig.name}] Error:`, err.message);
    }
  }

  savePosted(postedUrls);
  saveRotation(nextIndex);
  console.log(`\n✅ Cycle complete — ${published}/1 articles published.`);
  console.log(`⏭️  Next cycle: ${CATEGORIES_CONFIG[nextIndex].name}`);
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log('\n🚀 PolitiPlot Auto-Poster started! (Claude AI)');
console.log(`🌐 WordPress: ${WP_URL}`);
console.log('⏱️  Posting every 1 hour\n');

runCycle();
setInterval(runCycle, 60 * 60 * 1000);
