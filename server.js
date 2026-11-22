// Bored Arcade — game hub server
// Serves the arcade hub and every game in public/, relays live player state
// for each game's rooms, stores player accounts (email + password), and runs
// the hub's social features: friends, live status, chat, announcements.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
// Admins (can post announcements / What's new and make password-reset links): comma-separated emails
const ADMINS = new Set(String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
// players allowed per room: Storm Drop has one big shared room, Stick Rounds rooms are 1v1
const roomCap = (room) => (room === 'stormdrop' ? 40 : room.startsWith('sr-') ? 4 : room === 'hub' ? 200 : 16);
const MAX_TOTAL = 400;
const GAME_OF = (room) => (room === 'stormdrop' ? 'Storm Drop' : room.startsWith('sr-') ? 'Stick Rounds' : room === 'hub' ? 'hub' : null);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const COMPRESS = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt']);
const gzCache = new Map();
const originOf = (req) => (String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]) + '://' + String(req.headers.host || '').replace(/[^\w.:-]/g, '');

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
    const origin = originOf(req);
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
// Storage
//  - If DATABASE_URL is set (e.g. a free Neon Postgres database), everything is
//    stored there and survives restarts/redeploys.
//  - Otherwise it goes in data/accounts.json. On Render's free plan that file is
//    wiped whenever the server restarts, so set DATABASE_URL for real use.
// ---------------------------------------------------------------------------
const SESSION_DAYS = 90;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeFileStore() {
  const dir = path.join(__dirname, 'data');
  const file = path.join(dir, 'accounts.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  db = Object.assign({ users: {}, sessions: {}, nextId: 1, friends: [], chat: [], chatId: 1, kv: {}, resets: {} }, db);
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); }
      catch (e) { console.error('save failed', e.message); }
    }, 300);
  };
  const byId = (id) => Object.values(db.users).find((u) => u.id === id) || null;
  return {
    kind: 'file',
    async init() {},
    async getUserByEmail(email) { return db.users[email] || null; },
    async getUserById(id) { return byId(id); },
    async createUser(u) {
      if (db.users[u.email]) return null;
      const user = { id: db.nextId++, ...u, created: Date.now() };
      db.users[u.email] = user; save(); return user;
    },
    async updateUser(id, f) {
      const u = byId(id); if (!u) return false;
      if (f.email && f.email !== u.email) { if (db.users[f.email]) return false; delete db.users[u.email]; u.email = f.email; db.users[u.email] = u; }
      for (const k of ['name', 'salt', 'hash', 'data']) if (f[k] !== undefined) u[k] = f[k];
      save(); return true;
    },
    async deleteUser(id) {
      const u = byId(id); if (!u) return;
      delete db.users[u.email];
      for (const k of Object.keys(db.sessions)) if (db.sessions[k].uid === id) delete db.sessions[k];
      db.friends = db.friends.filter((f) => f.a !== id && f.b !== id);
      for (const m of db.chat) if (m.user_id === id) m.user_id = null;
      save();
    },
    async createSession(tokenHash, uid) { db.sessions[tokenHash] = { uid, created: Date.now() }; save(); },
    async getSession(tokenHash) {
      const s = db.sessions[tokenHash];
      if (!s) return null;
      if (Date.now() - s.created > SESSION_DAYS * 864e5) { delete db.sessions[tokenHash]; save(); return null; }
      return byId(s.uid);
    },
    async deleteSession(tokenHash) { delete db.sessions[tokenHash]; save(); },
    async deleteSessionsFor(uid) { for (const k of Object.keys(db.sessions)) if (db.sessions[k].uid === uid) delete db.sessions[k]; save(); },
    // friends: rows {a, b, ok} where a sent the request to b
    async friendRows(uid) {
      return db.friends.filter((f) => f.a === uid || f.b === uid).map((f) => {
        const other = f.a === uid ? f.b : f.a, u = byId(other);
        return u ? { id: other, name: u.name, accepted: f.ok, outgoing: f.a === uid } : null;
      }).filter(Boolean);
    },
    async addFriend(a, b) {
      const rev = db.friends.find((f) => f.a === b && f.b === a);
      if (rev) { rev.ok = true; save(); return 'accepted'; }
      if (db.friends.find((f) => f.a === a && f.b === b)) return 'exists';
      db.friends.push({ a, b, ok: false }); save(); return 'sent';
    },
    async acceptFriend(me, other) { const f = db.friends.find((x) => x.a === other && x.b === me); if (f) { f.ok = true; save(); } return !!f; },
    async removeFriend(me, other) { db.friends = db.friends.filter((f) => !((f.a === me && f.b === other) || (f.a === other && f.b === me))); save(); },
    async addChat(m) { const row = { id: db.chatId++, ...m, created: Date.now() }; db.chat.push(row); if (db.chat.length > 300) db.chat.splice(0, db.chat.length - 300); save(); return row; },
    async recentChat(n) { return db.chat.slice(-n); },
    async deleteChat(id) { db.chat = db.chat.filter((m) => m.id !== id); save(); },
    async getKV(k) { return db.kv[k] === undefined ? null : db.kv[k]; },
    async setKV(k, v) { db.kv[k] = v; save(); },
    async createReset(hash, uid, expires) { db.resets[hash] = { uid, expires }; save(); },
    async takeReset(hash) { const r = db.resets[hash]; delete db.resets[hash]; save(); return r && r.expires > Date.now() ? r.uid : null; },
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
  const one = async (text, params) => (await q(text, params)).rows[0] || null;
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
      await q(`CREATE TABLE IF NOT EXISTS sd_friends (
        a INTEGER NOT NULL REFERENCES sd_users(id) ON DELETE CASCADE, b INTEGER NOT NULL REFERENCES sd_users(id) ON DELETE CASCADE,
        accepted BOOLEAN NOT NULL DEFAULT false, created TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (a, b))`);
      await q(`CREATE TABLE IF NOT EXISTS sd_chat (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES sd_users(id) ON DELETE SET NULL, name TEXT NOT NULL, text TEXT NOT NULL,
        created TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS sd_kv (k TEXT PRIMARY KEY, v JSONB)`);
      await q(`CREATE TABLE IF NOT EXISTS sd_resets (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES sd_users(id) ON DELETE CASCADE, expires TIMESTAMPTZ NOT NULL)`);
      await q(`DELETE FROM sd_sessions WHERE created < now() - interval '${SESSION_DAYS} days'`);
      await q(`DELETE FROM sd_resets WHERE expires < now()`);
      await q(`DELETE FROM sd_chat WHERE id < (SELECT COALESCE(MAX(id),0) - 2000 FROM sd_chat)`);
    },
    getUserByEmail: (email) => one('SELECT * FROM sd_users WHERE email=$1', [email]),
    getUserById: (id) => one('SELECT * FROM sd_users WHERE id=$1', [id]),
    async createUser(u) {
      try { return await one('INSERT INTO sd_users (email,name,salt,hash,data) VALUES ($1,$2,$3,$4,$5) RETURNING *', [u.email, u.name, u.salt, u.hash, JSON.stringify(u.data)]); }
      catch (e) { if (e.code === '23505') return null; throw e; }
    },
    async updateUser(id, f) {
      const sets = [], vals = [id];
      for (const k of ['email', 'name', 'salt', 'hash', 'data']) if (f[k] !== undefined) { vals.push(k === 'data' ? JSON.stringify(f[k]) : f[k]); sets.push(k + '=$' + vals.length); }
      if (!sets.length) return true;
      try { await q('UPDATE sd_users SET ' + sets.join(',') + ' WHERE id=$1', vals); return true; }
      catch (e) { if (e.code === '23505') return false; throw e; }
    },
    async deleteUser(id) { await q('DELETE FROM sd_users WHERE id=$1', [id]); },
    async createSession(tokenHash, uid) { await q('INSERT INTO sd_sessions (token_hash,user_id) VALUES ($1,$2)', [tokenHash, uid]); },
    getSession: (tokenHash) => one(`SELECT u.* FROM sd_sessions s JOIN sd_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.created > now() - interval '${SESSION_DAYS} days'`, [tokenHash]),
    async deleteSession(tokenHash) { await q('DELETE FROM sd_sessions WHERE token_hash=$1', [tokenHash]); },
    async deleteSessionsFor(uid) { await q('DELETE FROM sd_sessions WHERE user_id=$1', [uid]); },
    async friendRows(uid) {
      const r = await q(`SELECT f.a, f.b, f.accepted, u.id, u.name FROM sd_friends f
        JOIN sd_users u ON u.id = CASE WHEN f.a=$1 THEN f.b ELSE f.a END WHERE f.a=$1 OR f.b=$1`, [uid]);
      return r.rows.map((x) => ({ id: x.id, name: x.name, accepted: x.accepted, outgoing: x.a === uid }));
    },
    async addFriend(a, b) {
      const rev = await one('UPDATE sd_friends SET accepted=true WHERE a=$1 AND b=$2 RETURNING a', [b, a]);
      if (rev) return 'accepted';
      const ins = await one('INSERT INTO sd_friends (a,b) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING a', [a, b]);
      return ins ? 'sent' : 'exists';
    },
    async acceptFriend(me, other) { return !!(await one('UPDATE sd_friends SET accepted=true WHERE a=$1 AND b=$2 RETURNING a', [other, me])); },
    async removeFriend(me, other) { await q('DELETE FROM sd_friends WHERE (a=$1 AND b=$2) OR (a=$2 AND b=$1)', [me, other]); },
    async addChat(m) {
      const r = await one('INSERT INTO sd_chat (user_id,name,text) VALUES ($1,$2,$3) RETURNING id, user_id, name, text, created', [m.user_id, m.name, m.text]);
      return { ...r, created: new Date(r.created).getTime() };
    },
    async recentChat(n) {
      const r = await q('SELECT id, user_id, name, text, created FROM sd_chat ORDER BY id DESC LIMIT $1', [n]);
      return r.rows.reverse().map((x) => ({ ...x, created: new Date(x.created).getTime() }));
    },
    async deleteChat(id) { await q('DELETE FROM sd_chat WHERE id=$1', [id]); },
    async getKV(k) { const r = await one('SELECT v FROM sd_kv WHERE k=$1', [k]); return r ? r.v : null; },
    async setKV(k, v) { await q('INSERT INTO sd_kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v', [k, JSON.stringify(v)]); },
    async createReset(hash, uid, expires) { await q('INSERT INTO sd_resets (token_hash,user_id,expires) VALUES ($1,$2,$3)', [hash, uid, new Date(expires)]); },
    async takeReset(hash) { const r = await one('DELETE FROM sd_resets WHERE token_hash=$1 RETURNING user_id, expires', [hash]); return r && new Date(r.expires).getTime() > Date.now() ? r.user_id : null; },
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
async function checkPassword(user, password) {
  const hash = await hashPassword(String(password || ''), user ? user.salt : 'no-user-salt');
  return !!user && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)));
function cleanName(n) { return String(n || '').replace(/[^\w \-.]/g, '').trim().slice(0, 12) || 'PLAYER'; }
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
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
const cleanText = (t, max) => String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function send(res, code, obj, extraHeaders) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extraHeaders || {}));
  res.end(JSON.stringify(obj));
}
// basic brute-force protection: 20 tries per 15 min per IP
const attempts = new Map();
function limited(ip, key = '') {
  const t = Date.now(), k = key + ip; let a = attempts.get(k);
  if (!a || t - a.start > 15 * 60e3) { a = { start: t, n: 0 }; attempts.set(k, a); }
  return ++a.n > 20;
}
setInterval(() => { const t = Date.now(); for (const [k, a] of attempts) if (t - a.start > 15 * 60e3) attempts.delete(k); }, 60e3);
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// Sessions: the token is sent as "Authorization: Bearer ..." by the pages, and also kept in a
// cookie so the server can tell which account is behind a game connection (for friends' live status).
const cookieOf = (req, name) => { const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || ''); return m ? m[1] : null; };
function sessionCookie(req, token) {
  const secure = /^https/.test(String(req.headers['x-forwarded-proto'] || '')) ? '; Secure' : '';
  return token ? `sd_tok=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}` : `sd_tok=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
function tokenOf(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (m) return m[1];
  const c = cookieOf(req, 'sd_tok');
  return c && /^[a-f0-9]{64}$/.test(c) ? c : null;
}
async function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.createSession(sha(token), uid);
  return token;
}
async function authUser(req) { const t = tokenOf(req); return t ? store.getSession(sha(t)) : null; }
const isAdmin = (u) => !!u && ADMINS.has(String(u.email).toLowerCase());
const friendCode = (u) => cleanName(u.name) + '#' + u.id;
function publicMe(u) { return { id: u.id, email: u.email, name: u.name, code: friendCode(u), admin: isAdmin(u), data: u.data }; }

// ---------- password reset emails (optional, via Brevo's free email API; Render's free plan blocks normal email)
async function sendResetEmail(to, link) {
  const key = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) return false;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Bored Arcade', email: from }, to: [{ email: to }], subject: 'Reset your Bored Arcade password',
      htmlContent: `<p>Someone asked to reset the password for your Bored Arcade account.</p><p><a href="${link}">Click here to pick a new password</a>. The link works for 1 hour.</p><p>If that wasn't you, just ignore this email.</p>`,
    }),
  });
  if (!r.ok) throw new Error('Email service error ' + r.status);
  return true;
}
async function makeResetLink(req, uid) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.createReset(sha(token), uid, Date.now() + 60 * 60e3);
  return originOf(req) + '/?reset=' + token;
}

// ---------- hub content: announcement banner + What's new
const DEFAULT_CHANGELOG = [
  { d: '2026-11-22', t: 'Bored Arcade is open! Storm Drop and Stick Rounds in one place, with friends, chat, accounts and live player counts.' },
  { d: '2026-11-19', t: 'Storm Drop: Ranked (Bronze to Grandmaster), shockwave grenades, the Grappler, the Kinetic Blade and 5 limited-time modes.' },
  { d: '2026-11-19', t: 'Storm Drop: coins and a cosmetics shop, map voting, and 4 maps including Winter Wonderland.' },
  { d: '2026-11-19', t: 'Storm Drop: building walls, watchtowers and a lighthouse, new hit effects. Grenades finally do damage.' },
  { d: '2026-11-18', t: 'Storm Drop is now 3D.' },
];
async function getAnnouncement() { return (await store.getKV('announce')) || null; }
async function getChangelog() { const c = await store.getKV('changelog'); return Array.isArray(c) ? c : DEFAULT_CHANGELOG; }

// ---------- live status of logged-in players (from their open hub/game connections)
const online = new Map(); // uid -> { name, socks: Set(ws) }
function statusOf(uid) {
  const o = online.get(uid); if (!o || !o.socks.size) return null;
  let st = null;
  for (const ws of o.socks) { const g = GAME_OF(ws.room); if (g && g !== 'hub') return g; if (g === 'hub') st = 'hub'; }
  return st;
}
const lastStatus = new Map();
async function friendIds(uid) { return (await store.friendRows(uid)).filter((f) => f.accepted).map((f) => f.id); }
function sendToUserHubs(uid, msg) {
  const o = online.get(uid); if (!o) return;
  const data = JSON.stringify(msg);
  for (const ws of o.socks) if (ws.room === 'hub' && ws.readyState === 1) ws.send(data);
}
async function statusChanged(uid) {
  const st = statusOf(uid);
  if (lastStatus.get(uid) === st) return;
  lastStatus.set(uid, st);
  if (!st) lastStatus.delete(uid);
  try {
    const name = (online.get(uid) || {}).name;
    for (const f of await friendIds(uid)) sendToUserHubs(f, { t: 'fs', id: uid, name, st });
  } catch (e) { console.error('status notify failed', errText(e)); }
}
function trackSocket(ws, user) {
  ws.uid = user.id;
  let o = online.get(user.id);
  if (!o) { o = { name: user.name, socks: new Set() }; online.set(user.id, o); }
  o.name = user.name; o.socks.add(ws);
  statusChanged(user.id);
}
function untrackSocket(ws) {
  if (!ws.uid) return;
  const o = online.get(ws.uid);
  if (o) { o.socks.delete(ws); if (!o.socks.size) online.delete(ws.uid); }
  // small delay so hopping from the hub into a game doesn't flash "offline"
  setTimeout(() => statusChanged(ws.uid), 4000);
}
async function friendsPayload(uid) {
  const rows = await store.friendRows(uid);
  return {
    friends: rows.filter((r) => r.accepted).map((r) => ({ id: r.id, name: r.name, code: r.name + '#' + r.id, st: statusOf(r.id) }))
      .sort((a, b) => (!!b.st - !!a.st) || a.name.localeCompare(b.name)),
    incoming: rows.filter((r) => !r.accepted && !r.outgoing).map((r) => ({ id: r.id, name: r.name, code: r.name + '#' + r.id })),
    outgoing: rows.filter((r) => !r.accepted && r.outgoing).map((r) => ({ id: r.id, name: r.name, code: r.name + '#' + r.id })),
  };
}
function hubBroadcast(msg) {
  const clients = rooms.get('hub'); if (!clients) return;
  const data = JSON.stringify(msg);
  for (const [, c] of clients) if (c.readyState === 1) c.send(data);
}
const chatOut = (m) => ({ id: m.id, uid: m.user_id, name: m.name, text: m.text, ts: m.created });

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
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

  const GETS = new Set(['/api/me', '/api/hub', '/api/friends']);
  if (req.method !== 'POST' && !GETS.has(url)) return send(res, 405, { error: 'Method not allowed' });
  try { await ensureReady(); }
  catch (e) { console.error('Database setup failed:', errText(e)); return send(res, 503, { error: 'Database problem: ' + errText(e) }); }

  if (url === '/api/hub') return send(res, 200, { ann: await getAnnouncement(), changelog: await getChangelog(), mail: !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM) });

  if (url === '/api/signup' || url === '/api/login') {
    if (limited(ipOf(req))) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!validEmail(email)) return send(res, 400, { error: 'Enter a valid email.' });
    if (password.length < 6 || password.length > 200) return send(res, 400, { error: 'Password needs at least 6 characters.' });
    let user;
    if (url === '/api/signup') {
      const salt = crypto.randomBytes(16).toString('hex');
      const data = cleanData(b.data);
      const name = cleanName(b.name || data.name);
      data.name = name;
      user = await store.createUser({ email, name, salt, hash: await hashPassword(password, salt), data });
      if (!user) return send(res, 409, { error: 'That email already has an account. Log in instead.' });
    } else {
      user = await store.getUserByEmail(email);
      if (!(await checkPassword(user, password))) return send(res, 401, { error: 'Wrong email or password.' });
    }
    const token = await newSession(user.id);
    return send(res, 200, { token, ...publicMe(user) }, { 'set-cookie': sessionCookie(req, token) });
  }

  if (url === '/api/forgot') {
    if (limited(ipOf(req), 'forgot')) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) return send(res, 400, { error: 'Enter a valid email.' });
    if (!(process.env.BREVO_API_KEY && process.env.MAIL_FROM))
      return send(res, 200, { ok: false, noMail: true, msg: "Reset emails aren't set up on this site yet. Ask the site owner to make you a reset link." });
    const user = await store.getUserByEmail(email);
    if (user) await sendResetEmail(email, await makeResetLink(req, user.id));
    return send(res, 200, { ok: true, msg: 'If that email has an account, a reset link is on its way. Check your inbox (and spam).' });
  }
  if (url === '/api/reset') {
    if (limited(ipOf(req), 'reset')) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
    const b = await readBody(req);
    const token = String(b.token || ''), password = String(b.password || '');
    if (password.length < 6 || password.length > 200) return send(res, 400, { error: 'Password needs at least 6 characters.' });
    const uid = /^[a-f0-9]{64}$/.test(token) ? await store.takeReset(sha(token)) : null;
    if (!uid) return send(res, 400, { error: 'This reset link has expired or was already used. Ask for a new one.' });
    const salt = crypto.randomBytes(16).toString('hex');
    await store.updateUser(uid, { salt, hash: await hashPassword(password, salt) });
    await store.deleteSessionsFor(uid);
    const user = await store.getUserById(uid);
    return send(res, 200, { ok: true, email: user && user.email });
  }

  const user = await authUser(req);
  const tok = tokenOf(req);
  if (!user) return send(res, 401, { error: 'Please log in again.' }, { 'set-cookie': sessionCookie(req, null) });
  const cookie = { 'set-cookie': sessionCookie(req, tok) }; // keep the cookie fresh for live status

  if (url === '/api/me') return send(res, 200, publicMe(user), cookie);
  if (url === '/api/save') {
    const b = await readBody(req);
    const data = cleanData(b.data);
    await store.updateUser(user.id, data.name ? { data, name: data.name } : { data });
    return send(res, 200, { ok: true }, cookie);
  }
  if (url === '/api/logout') {
    await store.deleteSession(sha(tok));
    return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, null) });
  }

  // ----- account settings
  if (url === '/api/account/update') {
    const b = await readBody(req);
    const f = {};
    if (b.name !== undefined) { f.name = cleanName(b.name); f.data = Object.assign({}, user.data || {}, { name: f.name }); }
    const wantsEmail = b.email !== undefined && String(b.email).trim().toLowerCase() !== user.email;
    const wantsPass = !!b.newPassword;
    if (wantsEmail || wantsPass) {
      if (limited(ipOf(req), 'acct')) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
      if (!(await checkPassword(user, b.password))) return send(res, 401, { error: 'Your current password is wrong.' });
    }
    if (wantsEmail) {
      const email = String(b.email).trim().toLowerCase();
      if (!validEmail(email)) return send(res, 400, { error: 'Enter a valid email.' });
      f.email = email;
    }
    if (wantsPass) {
      const np = String(b.newPassword);
      if (np.length < 6 || np.length > 200) return send(res, 400, { error: 'New password needs at least 6 characters.' });
      f.salt = crypto.randomBytes(16).toString('hex'); f.hash = await hashPassword(np, f.salt);
    }
    if (!(await store.updateUser(user.id, f))) return send(res, 409, { error: 'That email already has an account.' });
    const o = online.get(user.id); if (o && f.name) o.name = f.name;
    return send(res, 200, publicMe(await store.getUserById(user.id)), cookie);
  }
  if (url === '/api/account/delete') {
    const b = await readBody(req);
    if (limited(ipOf(req), 'acct')) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
    if (!(await checkPassword(user, b.password))) return send(res, 401, { error: 'Your password is wrong.' });
    await store.deleteUser(user.id);
    return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, null) });
  }

  // ----- friends
  if (url === '/api/friends') return send(res, 200, { code: friendCode(user), ...(await friendsPayload(user.id)) }, cookie);
  if (url === '/api/friends/add' || url === '/api/friends/accept' || url === '/api/friends/remove') {
    const b = await readBody(req);
    let other = null;
    if (url === '/api/friends/add') {
      const m = /#\s*(\d+)\s*$/.exec(String(b.code || ''));
      if (!m) return send(res, 400, { error: 'Enter a friend code like ALEX#12 (their name, a #, then the number).' });
      other = await store.getUserById(+m[1]);
      if (!other) return send(res, 404, { error: 'No player has that friend code.' });
      if (other.id === user.id) return send(res, 400, { error: "That's your own code!" });
      const r = await store.addFriend(user.id, other.id);
      sendToUserHubs(other.id, { t: 'fr', kind: r === 'accepted' ? 'accepted' : 'request', name: user.name });
      if (r === 'accepted') statusChanged(user.id), lastStatus.delete(other.id), statusChanged(other.id);
      return send(res, 200, { result: r, name: other.name, ...(await friendsPayload(user.id)) }, cookie);
    }
    const id = int(b.id, 1, 1e9);
    if (url === '/api/friends/accept') {
      await store.acceptFriend(user.id, id);
      sendToUserHubs(id, { t: 'fr', kind: 'accepted', name: user.name });
      lastStatus.delete(user.id); statusChanged(user.id);
    } else {
      await store.removeFriend(user.id, id);
      sendToUserHubs(id, { t: 'fr', kind: 'removed' });
    }
    return send(res, 200, await friendsPayload(user.id), cookie);
  }

  // ----- admin tools (ADMIN_EMAILS)
  if (url.startsWith('/api/admin/')) {
    if (!isAdmin(user)) return send(res, 403, { error: 'Only the site admin can do that.' });
    const b = await readBody(req);
    if (url === '/api/admin/announce') {
      const text = cleanText(b.text, 280);
      const ann = text ? { id: Date.now(), text } : null;
      await store.setKV('announce', ann);
      hubBroadcast({ t: 'ann', ann });
      return send(res, 200, { ok: true, ann });
    }
    if (url === '/api/admin/changelog') {
      const list = (await getChangelog()).slice();
      if (b.remove !== undefined) list.splice(int(b.remove, 0, 999), 1);
      else { const t = cleanText(b.text, 400); if (!t) return send(res, 400, { error: 'Write something first.' }); list.unshift({ d: new Date().toISOString().slice(0, 10), t }); }
      await store.setKV('changelog', list.slice(0, 60));
      hubBroadcast({ t: 'log', changelog: list.slice(0, 60) });
      return send(res, 200, { ok: true, changelog: list });
    }
    if (url === '/api/admin/resetlink') {
      const u = await store.getUserByEmail(String(b.email || '').trim().toLowerCase());
      if (!u) return send(res, 404, { error: 'No account with that email.' });
      return send(res, 200, { link: await makeResetLink(req, u.id), name: u.name });
    }
    if (url === '/api/admin/chatdelete') {
      await store.deleteChat(int(b.id, 1, 1e12));
      hubBroadcast({ t: 'chatdel', id: int(b.id, 1, 1e12) });
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => { console.error('api error', errText(e)); if (!res.headersSent) send(res, 500, { error: 'Server error: ' + errText(e) }); });
    return;
  }
  if (url === '/favicon.ico') { res.writeHead(301, { location: '/img/arcade-64.png' }); res.end(); }
  else if (url === '/health') res.end('ok');
  else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
  else { res.writeHead(405); res.end(); }
});

// ---------------------------------------------------------------------------
// Live connections: game rooms (relay) and the hub (chat, friends, announcements)
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

async function hubSocket(ws, req) {
  let user = null;
  try { await ensureReady(); user = await authUser(req); } catch {}
  if (ws.readyState !== 1) return;
  ws.user = user;
  let chat = [], ann = null;
  try { chat = (await store.recentChat(60)).map(chatOut); ann = await getAnnouncement(); } catch {}
  ws.send(JSON.stringify({ t: 'hello', me: user ? { id: user.id, name: user.name, admin: isAdmin(user) } : null, chat, ann }));
  if (user) {
    trackSocket(ws, user);
    try { ws.send(JSON.stringify({ t: 'friends', ...(await friendsPayload(user.id)) })); } catch {}
  }
  let lastMsg = 0;
  ws.on('message', async (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (!m || m.t !== 'chat') return;
    if (!ws.user) return ws.send(JSON.stringify({ t: 'err', error: 'Log in to chat.' }));
    const now = Date.now();
    if (now - lastMsg < 1200) return ws.send(JSON.stringify({ t: 'err', error: 'Slow down a little!' }));
    const text = cleanText(m.text, 200);
    if (!text) return;
    lastMsg = now;
    try {
      const fresh = await store.getUserById(ws.user.id);
      if (!fresh) return;
      const row = await store.addChat({ user_id: fresh.id, name: fresh.name, text });
      hubBroadcast({ t: 'chat', m: chatOut(row) });
    } catch (e) { ws.send(JSON.stringify({ t: 'err', error: 'Message not sent: ' + errText(e) })); }
  });
}

wss.on('connection', (ws, req) => {
  let room = 'stormdrop';
  try { room = (new URL(req.url, 'http://x').searchParams.get('room') || 'stormdrop').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'stormdrop'; } catch {}
  const clients = rooms.get(room) || new Map();
  if (clients.size >= roomCap(room) || total >= MAX_TOTAL) { ws.close(1013, 'full'); return; }
  rooms.set(room, clients);
  total++;
  const id = crypto.randomBytes(8).toString('hex');
  ws.id = id; ws.p = {}; ws.alive = true; ws.room = room;
  clients.set(id, ws);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('close', () => {
    total--;
    clients.delete(id);
    if (!clients.size) rooms.delete(room);
    untrackSocket(ws);
    if (room !== 'hub') broadcast(room, id, { t: 'bye', id });
  });

  if (room === 'hub') { hubSocket(ws, req).catch(() => {}); return; }

  // game rooms: if the player is logged in (cookie), mark them as playing this game
  if (tokenOf(req)) authUser(req).then((u) => { if (u && ws.readyState === 1) trackSocket(ws, u); }).catch(() => {});
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
});

// drop dead connections
setInterval(() => {
  for (const [, clients] of rooms) for (const [, c] of clients) { if (!c.alive) { c.terminate(); continue; } c.alive = false; try { c.ping(); } catch {} }
}, 15000);

ensureReady()
  .then(() => console.log('Accounts stored in: ' + (store.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : 'data/accounts.json (temporary on Render free — set DATABASE_URL to keep accounts)')))
  .catch((e) => console.error('Database setup failed:', errText(e)));
server.listen(PORT, () => console.log('Bored Arcade running on port ' + PORT + (ADMINS.size ? ' (admins: ' + ADMINS.size + ')' : ' (no ADMIN_EMAILS set)')));

// Optional: set KEEP_AWAKE=1 on Render to stop the free server from going to sleep after 15 idle minutes
// (it pings itself every 10 minutes). Note: an always-awake free service uses ~720 of the 750 free hours a month.
if (process.env.KEEP_AWAKE === '1' && process.env.RENDER_EXTERNAL_URL) {
  const https = require('https');
  setInterval(() => { https.get(process.env.RENDER_EXTERNAL_URL + '/health', (r) => r.resume()).on('error', () => {}); }, 10 * 60e3);
  console.log('Keep-awake is on');
}
