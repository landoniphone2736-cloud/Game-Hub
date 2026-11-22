// Bored Arcade — game hub server
// Serves the arcade hub and every game in public/, relays live player state
// for each game's rooms, and stores player accounts (email + password).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
// players allowed per room: Storm Drop has one big shared room, Stick Rounds rooms are 1v1
const roomCap = (room) => (room === 'stormdrop' ? 40 : room.startsWith('sr-') ? 4 : 16);
const MAX_TOTAL = 300;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const COMPRESS = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt']);
const gzCache = new Map();
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url); } catch { res.writeHead(400); return res.end('bad url'); }
  const file = path.normalize(path.join(PUB, rel));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) { res.writeHead(404); return res.end('not found'); }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!url.endsWith('/')) { res.writeHead(301, { location: url + '/' }); return res.end(); }
      return serveStatic(req, res, url + 'index.html');
    }
    if (err) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<h1>Not found</h1><p><a href="/">Back to the arcade</a></p>'); }
    const ext = path.extname(file).toLowerCase();
    // link previews (Discord, iMessage...) need full image URLs, so fill in this site's address
    const origin = (String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]) + '://' + String(req.headers.host || '').replace(/[^\w.:-]/g, '');
    const withOrigin = (buf, e) => (e === '.html' ? Buffer.from(buf.toString('utf8').replace(/content="\/img\//g, 'content="' + origin + '/img/')) : buf);
    const headers = { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' };
    // text files are sent gzipped (much faster first load); compressed copies are cached in memory
    if (COMPRESS.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      const key = file + ':' + st.mtimeMs + ':' + origin;
      let gz = gzCache.get(file);
      if (!gz || gz.key !== key) {
        try { gz = { key, buf: zlib.gzipSync(withOrigin(fs.readFileSync(file), ext), { level: 9 }) }; gzCache.set(file, gz); }
        catch { res.writeHead(500); return res.end(); }
      }
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': gz.buf.length, vary: 'Accept-Encoding' });
      return res.end(req.method === 'HEAD' ? undefined : gz.buf);
    }
    if (ext === '.html') {
      let body; try { body = withOrigin(fs.readFileSync(file), ext); } catch { res.writeHead(500); return res.end(); }
      res.writeHead(200, { ...headers, 'content-length': body.length });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Account storage
//  - If DATABASE_URL is set (e.g. a free Neon Postgres database), accounts are
//    stored there and survive restarts/redeploys.
//  - Otherwise they go in data/accounts.json. On Render's free plan that file is
//    wiped whenever the server restarts, so set DATABASE_URL for real use.
// ---------------------------------------------------------------------------
const SESSION_DAYS = 90;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeFileStore() {
  const dir = path.join(__dirname, 'data');
  const file = path.join(dir, 'accounts.json');
  let db = { users: {}, sessions: {}, nextId: 1 };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); }
      catch (e) { console.error('save failed', e.message); }
    }, 300);
  };
  return {
    kind: 'file',
    async init() {},
    async getUserByEmail(email) { return db.users[email] || null; },
    async createUser(u) {
      if (db.users[u.email]) return null;
      const user = { id: db.nextId++, ...u, created: Date.now() };
      db.users[u.email] = user; save(); return user;
    },
    async saveData(email, data, name) { const u = db.users[email]; if (!u) return; u.data = data; if (name) u.name = name; save(); },
    async createSession(tokenHash, email) { db.sessions[tokenHash] = { email, created: Date.now() }; save(); },
    async getSession(tokenHash) {
      const s = db.sessions[tokenHash];
      if (!s) return null;
      if (Date.now() - s.created > SESSION_DAYS * 864e5) { delete db.sessions[tokenHash]; save(); return null; }
      return db.users[s.email] || null;
    },
    async deleteSession(tokenHash) { delete db.sessions[tokenHash]; save(); },
  };
}

// Accept the connection string however it was pasted: trims quotes/spaces, a leading "psql",
// and drops URL options the Node driver doesn't need (we set SSL ourselves below).
function cleanDbUrl(raw) {
  let url = String(raw || '').trim().replace(/^psql\s+/i, '').replace(/^DATABASE_URL\s*=\s*/i, '').trim().replace(/^['"]|['"]$/g, '').trim();
  try {
    const u = new URL(url);
    for (const k of ['sslmode', 'channel_binding', 'sslrootcert', 'options']) u.searchParams.delete(k);
    url = u.toString();
  } catch {}
  return url;
}

function makePgStore(rawUrl) {
  const { Pool } = require('pg');
  const url = cleanDbUrl(rawUrl);
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  let host = '?';
  try { host = new URL(url).hostname; } catch {}
  console.log('Database host: ' + host);
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
  pool.on('error', (e) => console.error('db pool error', e.message));
  const q = (text, params) => pool.query(text, params);
  return {
    kind: 'postgres',
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS sd_users (
        id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        salt TEXT NOT NULL, hash TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS sd_sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES sd_users(id) ON DELETE CASCADE,
        created TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`DELETE FROM sd_sessions WHERE created < now() - interval '${SESSION_DAYS} days'`);
    },
    async getUserByEmail(email) { const r = await q('SELECT * FROM sd_users WHERE email=$1', [email]); return r.rows[0] || null; },
    async createUser(u) {
      try {
        const r = await q('INSERT INTO sd_users (email,name,salt,hash,data) VALUES ($1,$2,$3,$4,$5) RETURNING *', [u.email, u.name, u.salt, u.hash, JSON.stringify(u.data)]);
        return r.rows[0];
      } catch (e) { if (e.code === '23505') return null; throw e; }
    },
    async saveData(email, data, name) {
      if (name) await q('UPDATE sd_users SET data=$2, name=$3 WHERE email=$1', [email, JSON.stringify(data), name]);
      else await q('UPDATE sd_users SET data=$2 WHERE email=$1', [email, JSON.stringify(data)]);
    },
    async createSession(tokenHash, email) {
      await q('INSERT INTO sd_sessions (token_hash,user_id) SELECT $1,id FROM sd_users WHERE email=$2', [tokenHash, email]);
    },
    async getSession(tokenHash) {
      const r = await q(`SELECT u.* FROM sd_sessions s JOIN sd_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.created > now() - interval '${SESSION_DAYS} days'`, [tokenHash]);
      return r.rows[0] || null;
    },
    async deleteSession(tokenHash) { await q('DELETE FROM sd_sessions WHERE token_hash=$1', [tokenHash]); },
  };
}

const store = process.env.DATABASE_URL ? makePgStore(process.env.DATABASE_URL) : makeFileStore();
// Create the tables before the first account request (retries if the database was asleep or unreachable).
let ready = null;
function ensureReady() {
  if (!ready) ready = store.init().catch((e) => { ready = null; throw e; });
  return ready;
}
// short, safe error text for the player's screen (never includes the connection string)
const errText = (e) => String((e && (e.message || e.code)) || 'unknown').replace(/postgres(ql)?:\/\/\S+/gi, '[db]').slice(0, 120);

// ---------- helpers
function hashPassword(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));
}
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)));
function cleanName(n) { return String(n || '').replace(/[^\w \-.]/g, '').trim().slice(0, 12) || 'PLAYER'; }
// Only keep the fields the game uses, with sane ranges.
function cleanData(d) {
  d = d && typeof d === 'object' ? d : {};
  const out = { coins: int(d.coins, 0, 1e7), elo: int(d.elo, 0, 1e7), stats: {}, own: {}, cos: {}, t: int(d.t, 0, 1e15) };
  for (const k of ['games', 'kills', 'wins']) out.stats[k] = int(d.stats && d.stats[k], 0, 1e7);
  for (const k of ['h', 'p', 'c']) {
    const a = d.own && Array.isArray(d.own[k]) ? d.own[k] : [];
    out.own[k] = [...new Set(a.slice(0, 64).map((v) => int(v, 0, 63)).filter((v) => v > 0))];
    out.cos[k] = int(d.cos && d.cos[k], 0, 63);
  }
  if (typeof d.name === 'string') out.name = cleanName(d.name);
  if (d.col !== undefined) out.col = int(d.col, 0, 7);
  return out;
}
function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
// basic brute-force protection for login/signup: 20 tries per 15 min per IP
const attempts = new Map();
function limited(ip) {
  const t = Date.now(); let a = attempts.get(ip);
  if (!a || t - a.start > 15 * 60e3) { a = { start: t, n: 0 }; attempts.set(ip, a); }
  return ++a.n > 20;
}
setInterval(() => { const t = Date.now(); for (const [k, a] of attempts) if (t - a.start > 15 * 60e3) attempts.delete(k); }, 60e3);
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
async function newSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.createSession(sha(token), email);
  return token;
}
async function authUser(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  return m ? store.getSession(sha(m[1])) : null;
}

async function handleApi(req, res, url) {
  if (url === '/api/ping') return send(res, 200, { ok: true, db: store.kind });
  if (url === '/api/stats') {
    const out = { 'storm-drop': 0, 'stick-rounds': 0, names: { 'storm-drop': [], 'stick-rounds': [] } };
    const nm = (v) => (typeof v === 'string' ? v.replace(/[^\w \-.]/g, '').trim().slice(0, 12) : '');
    for (const [room, m] of rooms) {
      const g = room === 'stormdrop' ? 'storm-drop' : room.startsWith('sr-') ? 'stick-rounds' : null;
      if (!g) continue;
      out[g] += m.size;
      for (const [, c] of m) {
        const p = c.p || {};
        let n = g === 'storm-drop' ? nm(p.n) : (p.m && (Array.isArray(p.m.n) ? nm(p.m.n[0]) : nm(p.m.n)));
        if (n && out.names[g].length < 30 && !out.names[g].includes(n)) out.names[g].push(n);
      }
    }
    return send(res, 200, out);
  }

  if (req.method !== 'POST' && url !== '/api/me') return send(res, 405, { error: 'Method not allowed' });
  try { await ensureReady(); }
  catch (e) { console.error('Database setup failed:', errText(e)); return send(res, 503, { error: 'Database problem: ' + errText(e) }); }

  if (url === '/api/signup' || url === '/api/login') {
    if (limited(ipOf(req))) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return send(res, 400, { error: 'Enter a valid email.' });
    if (password.length < 6 || password.length > 200) return send(res, 400, { error: 'Password needs at least 6 characters.' });
    if (url === '/api/signup') {
      const salt = crypto.randomBytes(16).toString('hex');
      const data = cleanData(b.data);
      const name = cleanName(b.name || data.name);
      data.name = name;
      const user = await store.createUser({ email, name, salt, hash: await hashPassword(password, salt), data });
      if (!user) return send(res, 409, { error: 'That email already has an account. Log in instead.' });
      return send(res, 200, { token: await newSession(email), email, data: user.data });
    }
    const user = await store.getUserByEmail(email);
    const hash = await hashPassword(password, user ? user.salt : 'no-user-salt');
    if (!user || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex')))
      return send(res, 401, { error: 'Wrong email or password.' });
    return send(res, 200, { token: await newSession(email), email, data: user.data });
  }

  const user = await authUser(req);
  if (!user) return send(res, 401, { error: 'Please log in again.' });
  if (url === '/api/me') return send(res, 200, { email: user.email, name: user.name, data: user.data });
  if (url === '/api/save') {
    const b = await readBody(req);
    const data = cleanData(b.data);
    await store.saveData(user.email, data, data.name);
    return send(res, 200, { ok: true });
  }
  if (url === '/api/logout') {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (m) await store.deleteSession(sha(m[1]));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => { console.error('api error', errText(e)); if (!res.headersSent) send(res, 500, { error: 'Server error: ' + errText(e) }); });
    return;
  }
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); }
  else if (url === '/health') res.end('ok');
  else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
  else { res.writeHead(405); res.end(); }
});

// ---------------------------------------------------------------------------
// Live game relay
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
const rooms = new Map(); // room name -> Map(id -> ws)
let total = 0;

function broadcast(room, fromId, msg) {
  const data = JSON.stringify(msg);
  const clients = rooms.get(room);
  if (!clients) return;
  for (const [id, c] of clients) if (id !== fromId && c.readyState === 1) c.send(data);
}

wss.on('connection', (ws, req) => {
  let room = 'stormdrop';
  try { room = (new URL(req.url, 'http://x').searchParams.get('room') || 'stormdrop').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'stormdrop'; } catch {}
  const clients = rooms.get(room) || new Map();
  if (clients.size >= roomCap(room) || total >= MAX_TOTAL) { ws.close(1013, 'full'); return; }
  rooms.set(room, clients);
  total++;
  const id = crypto.randomBytes(8).toString('hex');
  ws.id = id; ws.p = {}; ws.alive = true;
  clients.set(id, ws);
  ws.send(JSON.stringify({ t: 'hello', you: id, peers: [...clients].filter(([k]) => k !== id).map(([k, c]) => [k, c.p]) }));

  let count = 0, windowStart = Date.now();
  ws.on('message', (buf) => {
    const t = Date.now();
    if (t - windowStart > 1000) { windowStart = t; count = 0; }
    if (++count > 60) return; // rate limit: 60 messages / second
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (!m || m.t !== 'p' || typeof m.d !== 'object' || m.d === null || Array.isArray(m.d)) return;
    const next = Object.assign({}, ws.p);
    for (const k in m.d) { if (m.d[k] === null) delete next[k]; else next[k] = m.d[k]; }
    if (JSON.stringify(next).length > 4096) return; // state size cap
    ws.p = next;
    broadcast(room, id, { t: 'p', id, d: m.d });
  });
  ws.on('pong', () => { ws.alive = true; });
  ws.on('close', () => {
    total--;
    clients.delete(id);
    if (!clients.size) rooms.delete(room);
    broadcast(room, id, { t: 'bye', id });
  });
});

// drop dead connections
setInterval(() => {
  for (const [, clients] of rooms) for (const [, c] of clients) { if (!c.alive) { c.terminate(); continue; } c.alive = false; try { c.ping(); } catch {} }
}, 15000);

ensureReady()
  .then(() => console.log('Accounts stored in: ' + (store.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : 'data/accounts.json (temporary on Render free — set DATABASE_URL to keep accounts)')))
  .catch((e) => console.error('Database setup failed:', errText(e)));
server.listen(PORT, () => console.log('Bored Arcade running on port ' + PORT));

// Optional: set KEEP_AWAKE=1 on Render to stop the free server from going to sleep after 15 idle minutes
// (it pings itself every 10 minutes). Note: an always-awake free service uses ~720 of the 750 free hours a month.
if (process.env.KEEP_AWAKE === '1' && process.env.RENDER_EXTERNAL_URL) {
  const https = require('https');
  setInterval(() => { https.get(process.env.RENDER_EXTERNAL_URL + '/health', (r) => r.resume()).on('error', () => {}); }, 10 * 60e3);
  console.log('Keep-awake is on');
}
