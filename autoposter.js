require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const Parser    = require('rss-parser');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');

const REQUIRED = ['ANTHROPIC_API_KEY', 'WP_URL', 'WP_USER', 'WP_APP_PASS'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing .env variables:', missing.join(', '));
  process.exit(1);
}

const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const parser   = new Parser({ timeout: 15000 });
const WP_URL   = process.env.WP_URL.replace(/\/$/, '').replace('/wp-admin', '');
const WP_USER  = process.env.WP_USER;
const WP_PASS  = process.env.WP_APP_PASS;
const AUTHOR_ID = 3;
const INTERVAL_HOURS = 4;

const POSTED_FILE   = path.join(__dirname, 'posted.json');
const ROTATION_FILE = path.join(__dirname, 'rotation.json');

function loadPosted() {
  try { if (fs.existsSync(POSTED_FILE)) return new Set(JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8'))); } catch (_) {}
  return new Set();
}
function savePosted(set) {
  try { fs.writeFileSync(POSTED_FILE, JSON.stringify([...set].slice(-500)), 'utf8'); } catch (_) {}
}
function loadRotation() {
  try { if (fs.existsSync(ROTATION_FILE)) return JSON.parse(fs.readFileSync(ROTATION_FILE, 'utf8')).index || 0; } catch (_) {}
  return 0;
}
function saveRotation(i) {
  try { fs.writeFileSync(ROTATION_FILE, JSON.stringify({ index: i }), 'utf8'); } catch (_) {}
}

const postedUrls = loadPosted();
console.log(`📂 Loaded ${postedUrls.size} posted URLs`);

const CATEGORIES = [
  {
    name: 'Politics',
    topic: 'US politics, Congress, Senate, White House, elections, policy',
    rss: ['https://rss.politico.com/politics-news.xml', 'https://thehill.com/rss/syndicator/19109'],
    keywords: ['trump','congress','senate','white house','republican','democrat','election','gop','president','executive order','tariff','immigration','vote','bill','policy'],
  },
  {
    name: 'Business',
    topic: 'US economy, Wall Street, stock market, trade, Federal Reserve, inflation',
    rss: ['https://feeds.reuters.com/reuters/businessNews', 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml'],
    keywords: ['economy','stock','market','tariff','trade','federal reserve','inflation','wall street','gdp','recession','jobs','unemployment','business'],
  },
  {
    name: 'Entertainment',
    topic: 'Hollywood, movies, celebrities, TV shows, music, awards, pop culture',
    rss: ['https://feeds.reuters.com/reuters/entertainment', 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml'],
    keywords: ['movie','film','celebrity','hollywood','music','award','oscar','grammy','netflix','disney','actor','singer'],
  },
  {
    name: 'Sports',
    topic: 'NFL, NBA, MLB, NHL, soccer, US sports, athletes, championships',
    rss: ['https://feeds.reuters.com/reuters/sportsNews', 'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml'],
    keywords: ['nfl','nba','mlb','nhl','football','basketball','baseball','soccer','sport','game','player','team','championship'],
  },
  {
    name: 'Technology',
    topic: 'AI, Silicon Valley, Apple, Google, Meta, Microsoft, startups, innovation',
    rss: ['https://feeds.reuters.com/reuters/technologyNews', 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml'],
    keywords: ['ai','tech','apple','google','meta','microsoft','openai','silicon valley','startup','software','robot','data','cyber'],
  },
  {
    name: 'World News',
    topic: 'International news, foreign policy, global conflicts, diplomacy, NATO',
    rss: ['https://feeds.reuters.com/reuters/worldNews', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'],
    keywords: ['war','nato','europe','china','russia','ukraine','middle east','iran','israel','united nations','foreign','global','sanctions'],
  },
  {
    name: 'US News',
    topic: 'US domestic news, American society, crime, education, health, environment',
    rss: ['https://feeds.npr.org/1003/rss.xml', 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml'],
    keywords: ['american','usa','united states','crime','education','health','environment','community','state','federal','infrastructure','housing'],
  },
];

async function fetchArticleForCategory(cat) {
  const articles = [];
  const allFeeds = [...cat.rss,
    'https://feeds.npr.org/1014/rss.xml',
    'https://feeds.washingtonpost.com/rss/politics',
    'https://www.cbsnews.com/latest/rss/politics',
  ];
  for (const feedUrl of allFeeds) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 10)) {
        if (!postedUrls.has(item.link)) {
          const summary = (item.contentSnippet || item.content || item.summary || '').replace(/<[^>]+>/g, '').substring(0, 2000);
          const titleLower = (item.title || '').toLowerCase();
          const match = cat.keywords.some(kw => titleLower.includes(kw)) ? 1 : 0;
          articles.push({ title: item.title, url: item.link, summary, source: feed.title, match });
        }
      }
    } catch (e) { console.warn(`⚠️ RSS failed (${feedUrl}): ${e.message}`); }
  }
  if (!articles.length) return null;
  articles.sort((a, b) => b.match - a.match);
  return articles[0];
}

async function rewriteWithClaude(article, cat) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = `You are a senior editor at Politiplot, an independent US news and analysis website.

TASK: Write an original news analysis article on the topic below.
Category: ${cat.name} | Topic focus: ${cat.topic}
Today's date: ${today}
Source publication: ${article.source}

CONTENT RULES:
- Length: 650-800 words
- Write factual, clear, engaging journalism
- Structure: strong lede (who/what/when/where/why), 3-4 body paragraphs with context and analysis, closing paragraph with implications
- Use active voice
- Cite the source naturally: e.g. "As reported by ${article.source}," or "According to ${article.source},"
- Add 1-2 sentences of original analysis or context per section — this is what makes the article unique
- End with a brief "What This Means" closing paragraph explaining implications for readers
- Add this exact disclaimer as the last line of article_html: <p class="ai-note"><em>This article was produced with AI assistance and reviewed by the Politiplot editorial team.</em></p>

HTML FORMAT:
- Paragraphs: <p>text</p>
- Subheadings: <h2>text</h2> (use 3-4, include focus keyword in at least one)
- Bold key facts: <strong>text</strong> (2-3 times maximum)
- No <html>, <body>, <head> tags

SEO (follow exactly):
1. focus_keyword: 2-4 words, most searched term for this topic
2. title: 55-60 characters, include focus keyword near start
3. slug: 4-6 words, lowercase, hyphens only
4. meta_description: 150-160 characters, include focus keyword, compelling
5. Use focus keyword in first paragraph, at least one H2, and 2-3 times in body naturally

TAGS: 5-7 specific tags (people, places, topics in article)

Return ONLY raw valid JSON, no markdown, no backticks:
{"title":"...","slug":"...","meta_description":"...","focus_keyword":"...","article_html":"...","tags":["..."],"category":"${cat.name}","persons":[{"name":"Full Name","jobTitle":"Their Role"}],"places":["City","Country"],"events":[{"name":"Event Name","startDate":"YYYY-MM-DD","location":"Place"}]}

- persons: real people mentioned in the article with their job title (max 5)
- places: real places mentioned (max 5, city or country names only)
- events: only if a specific named event is discussed (summit, election, trial etc), otherwise empty array []

TOPIC:
Title: ${article.title}
Summary: ${article.summary}
Source: ${article.source}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2500,
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

function buildNewsArticleSchema(content, postUrl, imageUrl) {
  const now = new Date().toISOString();

  // Build "about" array from persons and events
  const about = [];
  if (content.persons && content.persons.length > 0) {
    content.persons.forEach(p => {
      about.push({
        "@type": "Person",
        "name": p.name,
        ...(p.jobTitle ? { "jobTitle": p.jobTitle } : {}),
      });
    });
  }
  if (content.events && content.events.length > 0) {
    content.events.forEach(e => {
      about.push({
        "@type": "Event",
        "name": e.name,
        ...(e.startDate ? { "startDate": e.startDate } : {}),
        ...(e.location ? { "location": { "@type": "Place", "name": e.location } } : {}),
      });
    });
  }

  // Build "mentions" array from places
  const mentions = [];
  if (content.places && content.places.length > 0) {
    content.places.forEach(place => {
      mentions.push({ "@type": "Place", "name": place });
    });
  }

  const schema = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": content.title,
    "description": content.meta_description,
    "keywords": content.tags ? content.tags.join(', ') : content.focus_keyword,
    "datePublished": now,
    "dateModified": now,
    "author": {
      "@type": "Organization",
      "name": "PolitiPlot",
      "url": "https://politiplot.com"
    },
    "publisher": {
      "@type": "Organization",
      "name": "PolitiPlot",
      "url": "https://politiplot.com",
      "logo": {
        "@type": "ImageObject",
        "url": "https://politiplot.com/wp-content/uploads/2026/04/cropped-icon.jpeg",
        "width": 512,
        "height": 512
      }
    },
    "mainEntityOfPage": {
      "@type": "WebPage",
      "@id": postUrl || "https://politiplot.com"
    },
    "image": imageUrl ? {
      "@type": "ImageObject",
      "url": imageUrl,
      "width": 1200,
      "height": 630,
      "caption": content.title
    } : undefined,
    "articleSection": content.category,
    "inLanguage": "en-US",
  };

  if (about.length > 0) schema.about = about;
  if (mentions.length > 0) schema.mentions = mentions;

  return JSON.stringify(schema);
}

function convertToGutenbergBlocks(html) {
  let result = html;

  // Konverto <h2> ne Gutenberg heading block
  result = result.replace(/<h2>(.*?)<\/h2>/gi, (match, content) => {
    return `\n<!-- wp:heading -->\n<h2 class="wp-block-heading">${content}</h2>\n<!-- /wp:heading -->\n`;
  });

  // Konverto <p class="ai-note"> ne Gutenberg paragraph block
  result = result.replace(/<p class="ai-note">([\s\S]*?)<\/p>/gi, (match, content) => {
    return `\n<!-- wp:paragraph {"className":"ai-note"} -->\n<p class="ai-note">${content}</p>\n<!-- /wp:paragraph -->\n`;
  });

  // Konverto <p> te tjera ne Gutenberg paragraph block
  result = result.replace(/<p>([\s\S]*?)<\/p>/gi, (match, content) => {
    return `\n<!-- wp:paragraph -->\n<p>${content}</p>\n<!-- /wp:paragraph -->\n`;
  });

  // Konverto <script> schema ne HTML block
  result = result.replace(/(<script type="application\/ld\+json">[\s\S]*?<\/script>)/gi, (match) => {
    return `\n<!-- wp:html -->\n${match}\n<!-- /wp:html -->\n`;
  });

  return result.trim();
}

async function getCategoryIdByName(name, auth) {
  try {
    const res = await axios.get(`${WP_URL}/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}&per_page=10`, { headers: { Authorization: `Basic ${auth}` } });
    const found = res.data.find(c => c.name.toLowerCase() === name.toLowerCase());
    return found ? found.id : null;
  } catch (e) { console.warn('Category error:', e.message); return null; }
}

async function getOrCreateTags(tags, auth) {
  const ids = [];
  for (const tagName of (tags || [])) {
    try {
      const res = await axios.get(`${WP_URL}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}`, { headers: { Authorization: `Basic ${auth}` } });
      if (res.data.length > 0) { ids.push(res.data[0].id); continue; }
      const created = await axios.post(`${WP_URL}/wp-json/wp/v2/tags`, { name: tagName }, { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } });
      ids.push(created.data.id);
    } catch (e) { console.warn(`Tag error (${tagName}):`, e.message); }
  }
  return ids;
}

function detectPolitician(title, keyword) {
  const text = (title + ' ' + keyword).toLowerCase();
  const politicians = [
    { name: 'Donald Trump', terms: ['trump','donald trump'] },
    { name: 'Joe Biden', terms: ['biden','joe biden'] },
    { name: 'Kamala Harris', terms: ['kamala','harris'] },
    { name: 'Barack Obama', terms: ['obama'] },
    { name: 'Elon Musk', terms: ['elon musk','musk'] },
    { name: 'Ron DeSantis', terms: ['desantis'] },
    { name: 'Nikki Haley', terms: ['haley'] },
    { name: 'Bernie Sanders', terms: ['bernie','sanders'] },
    { name: 'Marco Rubio', terms: ['rubio'] },
    { name: 'Ted Cruz', terms: ['ted cruz'] },
  ];
  for (const p of politicians) {
    if (p.terms.some(t => text.includes(t))) return p.name;
  }
  return null;
}

function buildImageQuery(title, keyword, categoryName) {
  const categoryBase = {
    'Politics': 'washington dc capitol government',
    'Business': 'business finance economy wall street',
    'Entertainment': 'entertainment hollywood',
    'Sports': 'sports athlete stadium',
    'Technology': 'technology digital innovation',
    'World News': 'international world diplomacy',
    'US News': 'america united states news',
  };
  const politician = detectPolitician(title, keyword);
  if (politician && categoryName === 'Politics') return politician;
  const stopWords = ['the','a','an','of','in','on','at','to','for','and','or','but','is','was','are','were','has','have','with','that','this','from','by','as'];
  const titleWords = title.replace(/[^a-zA-Z ]/g, '').split(' ').filter(w => w.length > 3 && !stopWords.includes(w.toLowerCase())).slice(0, 3).join(' ');
  return (titleWords || keyword) + ' ' + (categoryBase[categoryName] || '');
}

async function uploadFeaturedImage(keyword, categoryName, articleTitle, auth) {
  const PEXELS_KEY = process.env.PEXELS_API_KEY;
  const query = buildImageQuery(articleTitle || keyword, keyword, categoryName);
  console.log(`🔍 Image search: "${query}"`);
  let imageUrl = null;
  let altText  = keyword;

  if (PEXELS_KEY) {
    try {
      const res = await axios.get('https://api.pexels.com/v1/search', {
        headers: { Authorization: PEXELS_KEY },
        params: { query, per_page: 15, orientation: 'landscape' },
        timeout: 15000,
      });
      const photos = res.data?.photos || [];
      if (photos.length > 0) {
        const pick = photos[Math.floor(Math.random() * Math.min(8, photos.length))];
        imageUrl = pick.src.large2x || pick.src.large;
        altText  = `${query} - Photo by ${pick.photographer} on Pexels`;
        console.log(`✅ Pexels: by ${pick.photographer}`);
      }
    } catch (e) { console.warn('⚠️ Pexels error:', e.message); }
  }

  if (!imageUrl) {
    const wikiFallbacks = {
      'Politics': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a3/US_Capitol_Building_at_night_Jan_2006.jpg/1200px-US_Capitol_Building_at_night_Jan_2006.jpg',
      'Business': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/NYSE_MKT_LLC_stocks_board.jpg/1200px-NYSE_MKT_LLC_stocks_board.jpg',
      'Entertainment': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Hollywood_Sign_in_the_Hollywood_Hills.jpg/1200px-Hollywood_Sign_in_the_Hollywood_Hills.jpg',
      'Sports': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f3/Salsa_at_Yankee_Stadium.jpg/1200px-Salsa_at_Yankee_Stadium.jpg',
      'Technology': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Googleplex-Patio-Aug-2014.JPG/1200px-Googleplex-Patio-Aug-2014.JPG',
      'World News': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e3/United_Nations_Headquarters_in_New_York_City.jpg/1200px-United_Nations_Headquarters_in_New_York_City.jpg',
      'US News': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a3/US_Capitol_Building_at_night_Jan_2006.jpg/1200px-US_Capitol_Building_at_night_Jan_2006.jpg',
    };
    imageUrl = wikiFallbacks[categoryName] || wikiFallbacks['Politics'];
    console.log(`🔍 Using Wikimedia fallback for: ${categoryName}`);
  }

  try {
    const imgResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000, maxRedirects: 5 });
    const buffer   = Buffer.from(imgResponse.data);
    const filename = keyword.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '-' + Date.now() + '.jpg';
    const FormData = require('form-data');
    const form     = new FormData();
    form.append('file', buffer, { filename, contentType: 'image/jpeg' });
    const uploadRes = await axios.post(`${WP_URL}/wp-json/wp/v2/media`, form, {
      headers: { ...form.getHeaders(), Authorization: `Basic ${auth}` },
      timeout: 30000,
    });
    await axios.post(`${WP_URL}/wp-json/wp/v2/media/${uploadRes.data.id}`, { alt_text: altText, caption: altText, title: keyword }, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    }).catch(() => {});
    console.log(`🖼️  Image uploaded OK`);
    return { id: uploadRes.data.id, url: uploadRes.data.source_url };
  } catch (e) {
    console.warn(`⚠️ Image upload failed: ${e.message}`);
    return { id: null, url: imageUrl };
  }
}

async function runCycle() {
  console.log(`\n🕐 ${new Date().toLocaleString()} — Starting cycle...`);
  const auth = Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');

  const rotIndex   = loadRotation();
  const currentIdx = rotIndex % CATEGORIES.length;
  const nextIdx    = (currentIdx + 1) % CATEGORIES.length;
  const cat        = CATEGORIES[currentIdx];

  console.log(`🔄 Rotation ${currentIdx + 1}/${CATEGORIES.length}: ${cat.name}`);

  try {
    const article = await fetchArticleForCategory(cat);
    if (!article) {
      console.log(`ℹ️  No new article for ${cat.name}`);
      saveRotation(nextIdx);
      return;
    }
    console.log(`📰 Found: ${article.title}`);

    console.log(`🤖 Rewriting with Claude...`);
    const content = await rewriteWithClaude(article, cat);
    console.log(`✅ "${content.title}"`);

    const categoryId = await getCategoryIdByName(cat.name, auth);
    const [tagIds, imageData] = await Promise.all([
      getOrCreateTags(content.tags, auth),
      uploadFeaturedImage(content.focus_keyword, cat.name, content.title, auth),
    ]);

    const postUrl = `${WP_URL}/${content.slug}/`;
    const schema  = buildNewsArticleSchema(content, postUrl, imageData.url);
    const rawContent = content.article_html + `\n<script type="application/ld+json">${schema}<\/script>`;
    const articleWithSchema = convertToGutenbergBlocks(rawContent);

    const postData = {
      title:          content.title,
      content:        articleWithSchema,
      slug:           content.slug,
      status:         'publish',
      excerpt:        content.meta_description,
      tags:           tagIds,
      categories:     categoryId ? [categoryId] : [],
      featured_media: imageData.id || 0,
      author:         AUTHOR_ID,
      yoast_title:    content.title,
      yoast_metadesc: content.meta_description,
      yoast_focuskw:  content.focus_keyword,
    };

    const response = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, postData, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    console.log(`🎉 Published [${cat.name}] → ${response.data.link}`);
    postedUrls.add(article.url);
    savePosted(postedUrls);
    saveRotation(nextIdx);

  } catch (err) {
    if (err.response)
      console.error(`❌ HTTP ${err.response.status}:`, JSON.stringify(err.response.data).substring(0, 200));
    else
      console.error(`❌ Error:`, err.message);
    saveRotation(nextIdx);
  }
}

// Random delay: 4 hours + 0-45 minutes random
function getRandomDelay() {
  const randomMinutes = Math.floor(Math.random() * 45);
  return (INTERVAL_HOURS * 60 + randomMinutes) * 60 * 1000;
}

function scheduleNext() {
  const delay = getRandomDelay();
  const nextTime = new Date(Date.now() + delay);
  console.log(`⏭️  Next post scheduled: ${nextTime.toLocaleString()}`);
  setTimeout(() => {
    runCycle();
    scheduleNext();
  }, delay);
}

console.log('\n🚀 PolitiPlot Auto-Poster v4.0 started!');
console.log(`🌐 WordPress: ${WP_URL}`);
console.log(`⏱️  Posting every ~${INTERVAL_HOURS} hours (randomized +0-45min)\n`);

async function start() {
  await runCycle();
  scheduleNext();
}

start();
