// GET /api/livestats → 방송 기록 (월별 방송 횟수 통계용)
// - 누가 호출하든 1분에 한 번씩 "지금 방송 중인 멤버"를 기록 (유튜브 영상 번호 / SOOP 방송 번호 단위로 1회)
// - 관리자가 ?month=2026-10 으로 부르면 그 달 기록을 돌려줌
// - api/youtube.js 는 건드리지 않고, 그 결과(저장소에 남긴 값)만 읽어서 씀
const { loadData, getJSON, setJSON, redis, send, isAdmin } = require('./_lib');

const CH_KEY = 'oho:yt:ch', LIVE_KEY = 'oho:yt:live';
const LOG_KEY = 'oho:livelog', TICK_KEY = 'oho:livelog:tick';
const KEEP = 400 * 24 * 3600 * 1000; // 약 13개월 보관
const MANUAL_GAP = 30 * 60 * 1000;   // 수동 LIVE가 30분 넘게 끊기면 다른 방송으로 셈

function parseSoop(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)(sooplive\.co\.kr|sooplive\.com|afreecatv\.com)$/.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    const id = seg[0] === 'station' ? seg[1] : seg[0];
    return id && /^[\w.-]{2,40}$/.test(id) ? id.toLowerCase() : null;
  } catch { return null; }
}
const guessPlat = (m) => /sooplive|afreecatv/i.test(m.liveUrl || '') ? 'soop'
  : /youtube\.com|youtu\.be/i.test(m.liveUrl || '') ? 'youtube'
  : m.soopUrl ? 'soop' : m.channelUrl ? 'youtube' : '';

async function tick(req) {
  // 유튜브/SOOP 확인을 먼저 깨움 (오래됐으면 youtube.js가 새로 확인함)
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
      await fetch(`https://${host}/api/youtube?from=stats`, { signal: ctrl.signal }).catch(() => {}).finally(() => clearTimeout(t));
    }
  } catch {}

  const now = Date.now();
  const [data, ch, liveCache, log] = await Promise.all([
    loadData(), getJSON(CH_KEY, {}), getJSON(LIVE_KEY, { at: 0, live: {} }), getJSON(LOG_KEY, { s: {} }),
  ]);
  const s = log.s || {};
  const fresh = now - (liveCache.at || 0) < 15 * 60 * 1000; // 확인 결과가 15분 넘게 오래됐으면 자동 감지분은 기록 안 함
  const soopFresh = now - (liveCache.soopAt || 0) < 25 * 60 * 1000;
  let changed = false;
  const hit = (key, who, plat, title) => {
    if (s[key]) { s[key].e = now; if (title && !s[key].t) s[key].t = title; }
    else s[key] = { m: who, p: plat, b: now, e: now, t: title || '' };
    changed = true;
  };

  for (const [id, m] of Object.entries(data.members || {})) {
    const c = ch[m.channelUrl];
    const lv = fresh && c && !c.bad && c.id && (liveCache.live || {})[c.id];
    const sid = m.soopUrl && parseSoop(m.soopUrl);
    const sv = soopFresh && sid && (liveCache.soop || {})[sid];
    if (lv) hit('y:' + lv.videoId, id, 'youtube', lv.title);
    if (sv) hit('s:' + sid + ':' + sv.broadNo, id, 'soop', sv.title);
    if (!lv && !sv && m.live) {
      // 관리자가 직접 켠 LIVE: 30분 안에 이어지면 같은 방송
      const open = Object.keys(s).find(k => k.startsWith('m:' + id + ':') && now - s[k].e < MANUAL_GAP);
      hit(open || ('m:' + id + ':' + now), id, guessPlat(m), '');
    }
  }
  for (const [id, l] of Object.entries(data.labels || {})) {
    const c = ch[l.ytUrl];
    const lv = fresh && c && !c.bad && c.id && (liveCache.live || {})[c.id];
    if (lv) hit('y:' + lv.videoId, 'label:' + id, 'youtube', lv.title);
  }

  for (const k of Object.keys(s)) if (now - s[k].e > KEEP) { delete s[k]; changed = true; }
  if (changed) await setJSON(LOG_KEY, { s });
}

// 한국 시간 기준 'YYYY-MM'
const kstMonth = (t) => new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 7);

module.exports = async (req, res) => {
  try {
    // 1분에 한 번만 기록 (여러 사람이 동시에 열어도 한 번)
    const got = await redis(['SET', TICK_KEY, '1', 'NX', 'EX', '55']).catch(() => 'OK');
    if (got === 'OK') await tick(req).catch(() => {});

    const url = new URL(req.url, 'http://x');
    const month = url.searchParams.get('month');
    if (!month) return send(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
    if (!isAdmin(req)) return send(res, 401, { error: '관리자만 볼 수 있어요' });
    if (!/^\d{4}-\d{2}$/.test(month)) return send(res, 400, { error: '달 형식이 맞지 않아요' });

    const log = await getJSON(LOG_KEY, { s: {} });
    const sessions = Object.values(log.s || {}).filter(x => kstMonth(x.b) === month)
      .map(x => ({ m: x.m, p: x.p, b: x.b, e: x.e, t: x.t }));
    const months = [...new Set(Object.values(log.s || {}).map(x => kstMonth(x.b)))].sort();
    send(res, 200, { month, sessions, months, since: months[0] || null }, { 'Cache-Control': 'no-store' });
  } catch (e) { send(res, 200, { error: String(e.message || e), sessions: [] }); }
};
