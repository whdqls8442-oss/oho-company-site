// 공용 도구: 저장소(Upstash Redis), 관리자 인증, 요청 본문 읽기
const crypto = require('crypto');
const SEED = require('./_seed.json');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const DATA_KEY = 'oho:data';
const APPS_KEY = 'oho:apps';
const COLLECTIONS = ['labels', 'members', 'events', 'hall', 'posts', 'settings'];

// 저장소가 아직 연결되지 않았을 때(처음 배포 직후) 쓰는 임시 메모리
const mem = {};

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    const [op, key, val] = cmd;
    if (op === 'GET') return mem[key] ?? null;
    if (op === 'SET') { mem[key] = val; return 'OK'; }
    if (op === 'DEL') { delete mem[key]; return 1; }
    return null;
  }
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error('저장소 오류 ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function getJSON(key, fallback) {
  const v = await redis(['GET', key]);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
async function setJSON(key, value) { return redis(['SET', key, JSON.stringify(value)]); }

async function loadData() {
  const d = await getJSON(DATA_KEY, null);
  if (d) { for (const c of COLLECTIONS) d[c] = d[c] || {}; return d; }
  const seeded = JSON.parse(JSON.stringify(SEED));
  for (const c of COLLECTIONS) seeded[c] = seeded[c] || {};
  return seeded;
}
async function saveData(d) { return setJSON(DATA_KEY, d); }

// ---- 관리자 인증 (비밀번호 → 서명된 토큰, 30일) ----
function secret() { return (process.env.AUTH_SECRET || '') + '|' + (process.env.ADMIN_PASSWORD || ''); }
function sign(payload) { return crypto.createHmac('sha256', secret()).update(payload).digest('hex'); }
function makeToken() {
  const exp = String(Date.now() + 30 * 24 * 3600 * 1000);
  return exp + '.' + sign(exp);
}
function isAdmin(req) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  let b;
  try { b = req.body; } catch { b = undefined; }
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string' && b.length) return Buffer.from(b);
  if (b && typeof b === 'object') return Buffer.from(JSON.stringify(b));
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('파일이 너무 커요'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJSON(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const b = await readBody(req, 1024 * 1024);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
}

function send(res, status, obj, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

const storeReady = () => !!(REDIS_URL && REDIS_TOKEN);

module.exports = { redis, getJSON, setJSON, loadData, saveData, makeToken, isAdmin, readBody, readJSON, send, storeReady, COLLECTIONS, APPS_KEY };
