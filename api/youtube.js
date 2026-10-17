// GET /api/youtube → 멤버별 유튜브 프로필 사진·구독자 수·라이브 여부
// - 채널 정보(사진·구독자)는 6시간마다 갱신
// - 라이브 여부는 10분마다 갱신 (채널 RSS로 최근 영상을 찾고, videos API로 '방송 중'인지 확인)
// 하루 사용량: 멤버 30명 기준 약 3,000~4,000 단위 (무료 한도 10,000)
const { loadData, getJSON, setJSON, redis, send } = require('./_lib');

const KEY = process.env.YOUTUBE_API_KEY;
const SOOP_ID = process.env.SOOP_CLIENT_ID;
const API = 'https://www.googleapis.com/youtube/v3';
const CH_KEY = 'oho:yt:ch', LIVE_KEY = 'oho:yt:live', LOCK_KEY = 'oho:yt:lock';
// 유튜브·SOOP 모두 10분마다 확인 (GitHub Actions가 10분마다 깨움 → 깨울 때마다 확인되도록 9분으로 둠)
const CH_TTL = 6 * 3600 * 1000, LIVE_TTL = 9 * 60 * 1000, SOOP_TTL = 9 * 60 * 1000;

function parseChannel(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    const p = decodeURIComponent(u.pathname);
    let m = p.match(/^\/(@[^/]+)/); if (m) return { handle: m[1] };
    m = p.match(/^\/channel\/(UC[\w-]{20,})/); if (m) return { id: m[1] };
    m = p.match(/^\/(?:user|c)\/([^/]+)/); if (m) return { user: m[1] };
  } catch {}
  return null;
}

async function yt(path, params) {
  const qs = new URLSearchParams({ ...params, key: KEY });
  const r = await fetch(`${API}/${path}?${qs}`);
  const j = await r.json();
  if (j.error) throw new Error('YouTube API: ' + (j.error.message || r.status));
  return j;
}
const best = (t) => (t && (t.high || t.medium || t.default) || {}).url || '';

async function refreshChannels(urls, cache) {
  const now = Date.now();
  const todo = urls.filter(u => !cache[u] || now - (cache[u].at || 0) > CH_TTL);
  const byId = [];
  for (const u of todo) {
    const p = parseChannel(u);
    if (!p) { cache[u] = { at: now, bad: true }; continue; }
    if (p.id) { byId.push([u, p.id]); continue; }
    try {
      const j = await yt('channels', { part: 'snippet,statistics', ...(p.handle ? { forHandle: p.handle } : { forUsername: p.user }) });
      const c = (j.items || [])[0];
      cache[u] = c ? { at: now, id: c.id, title: c.snippet.title, photo: best(c.snippet.thumbnails), subs: c.statistics.hiddenSubscriberCount ? null : Number(c.statistics.subscriberCount) } : { at: now, bad: true };
    } catch (e) { cache[u] = { ...(cache[u] || {}), at: now - CH_TTL + 600000, err: String(e.message) }; }
  }
  for (let i = 0; i < byId.length; i += 50) {
    const part = byId.slice(i, i + 50);
    try {
      const j = await yt('channels', { part: 'snippet,statistics', id: part.map(x => x[1]).join(',') });
      const map = Object.fromEntries((j.items || []).map(c => [c.id, c]));
      for (const [u, id] of part) {
        const c = map[id];
        cache[u] = c ? { at: now, id, title: c.snippet.title, photo: best(c.snippet.thumbnails), subs: c.statistics.hiddenSubscriberCount ? null : Number(c.statistics.subscriberCount) } : { at: now, bad: true };
      }
    } catch (e) { for (const [u] of part) cache[u] = { ...(cache[u] || {}), at: now - CH_TTL + 600000 }; }
  }
  return cache;
}

async function recentVideoIds(channelId, n = 5) {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const xml = await r.text();
    return [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].slice(0, n).map(m => m[1]);
  } catch { return []; }
}

// 채널의 /live 페이지를 직접 열어 지금 방송 중인 영상 ID를 찾음 (유튜브 API 사용량 0)
// 찾은 ID는 아래 videos API로 한 번 더 '방송 중'인지 확인하므로 잘못 뜰 일은 없음
async function liveVideoIdFromPage(channelId) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
    return m && /"isLive(?:Now)?":true/.test(html) ? m[1] : null;
  } catch { return null; }
}

// 레이블 공식 채널은 쇼츠·영상이 많아 방송이 최근 5개 밖으로 밀릴 수 있어 15개까지 확인 + /live 페이지도 확인
async function refreshLive(channelIds, deepIds = new Set()) {
  const lists = await Promise.all(channelIds.map(async id => {
    const vids = await recentVideoIds(id, deepIds.has(id) ? 15 : 5);
    if (deepIds.has(id)) { const lv = await liveVideoIdFromPage(id); if (lv && !vids.includes(lv)) vids.unshift(lv); }
    return [id, vids];
  }));
  const vidToCh = {};
  for (const [ch, vids] of lists) for (const v of vids) vidToCh[v] = ch;
  const vids = Object.keys(vidToCh), live = {};
  for (let i = 0; i < vids.length; i += 50) {
    const j = await yt('videos', { part: 'snippet', id: vids.slice(i, i + 50).join(',') });
    for (const v of j.items || []) {
      if (v.snippet.liveBroadcastContent === 'live') {
        const t = v.snippet.thumbnails || {};
        live[vidToCh[v.id]] = { videoId: v.id, title: v.snippet.title, thumb: (t.maxres || t.standard || t.high || t.medium || {}).url || `https://i.ytimg.com/vi/${v.id}/hqdefault_live.jpg` };
      }
    }
  }
  return live;
}

// ── SOOP: 공식 Open API(broad/list, Public)로 '지금 방송 중인 전체 목록'을 넘겨보며 우리 멤버를 찾음
// 멤버를 모두 찾으면 바로 멈추고, 못 찾으면 목록 끝까지 확인 (확인 주기 10분)
function parseSoop(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)(sooplive\.co\.kr|sooplive\.com|afreecatv\.com)$/.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    const id = seg[0] === 'station' ? seg[1] : seg[0];
    return id && /^[\w.-]{2,40}$/.test(id) ? id.toLowerCase() : null;
  } catch { return null; }
}
async function soopPage(page) {
  const qs = new URLSearchParams({ client_id: SOOP_ID, page_no: String(page) });
  const r = await fetch(`https://openapi.sooplive.com/broad/list?${qs}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('SOOP ' + r.status);
  return r.json();
}
let soopStat = {};
async function refreshSoop(ids) {
  const want = new Set(ids), found = {};
  soopStat = { enabled: !!SOOP_ID, watching: want.size };
  if (!SOOP_ID || !want.size) return found;
  const take = (j) => { for (const b of (j && j.broad) || []) { const id = String(b.user_id || '').toLowerCase(); if (want.has(id) && !found[id]) found[id] = { broadNo: b.broad_no, title: b.broad_title || '', thumb: b.broad_thumb ? 'https:' + String(b.broad_thumb).replace(/^https?:/, '') : '' }; } };
  const first = await soopPage(1);
  if (!first || !Array.isArray(first.broad)) throw new Error('SOOP 응답 오류: ' + JSON.stringify(first).slice(0, 150));
  take(first);
  const per = Number(first.page_block) || 60, pages = Math.min(Math.ceil((Number(first.total_cnt) || 0) / per), 300);
  soopStat.total = Number(first.total_cnt) || 0; soopStat.pages = pages;
  for (let p = 2; p <= pages && Object.keys(found).length < want.size; p += 8) {
    const batch = [];
    for (let q = p; q < p + 8 && q <= pages; q++) batch.push(soopPage(q).then(take).catch(() => {}));
    await Promise.all(batch);
  }
  soopStat.found = Object.keys(found).length;
  return found;
}

module.exports = async (req, res) => {
  if (!KEY) return send(res, 200, { disabled: true, members: {} });
  try {
    const data = await loadData();
    const members = Object.entries(data.members || {});
    const labels = Object.entries(data.labels || {});
    const urls = [...new Set([...members.map(([, m]) => m.channelUrl), ...labels.map(([, l]) => l.ytUrl)].filter(u => u && /youtube\.com/.test(u)))];

    let ch = await getJSON(CH_KEY, {});
    let liveCache = await getJSON(LIVE_KEY, { at: 0, live: {} });
    const stale = urls.some(u => !ch[u] || Date.now() - (ch[u].at || 0) > CH_TTL) || Date.now() - liveCache.at > LIVE_TTL;

    if (stale) {
      // 동시에 여러 번 갱신하지 않도록 잠금 (실패하면 지난 결과를 그대로 보여줌)
      const got = await redis(['SET', LOCK_KEY, '1', 'NX', 'EX', '60']).catch(() => 'OK');
      if (got === 'OK') {
        try {
          ch = await refreshChannels(urls, ch);
          await setJSON(CH_KEY, ch);
          if (Date.now() - liveCache.at > LIVE_TTL) {
            const ids = [...new Set(urls.map(u => ch[u] && ch[u].id).filter(Boolean))];
            const soopIds = [...new Set(members.map(([, m]) => m.soopUrl && parseSoop(m.soopUrl)).filter(Boolean))];
            // SOOP이 거절(한도 초과 등)하면 1시간 동안 SOOP 확인을 쉬었다가 다시 시도
            const soopDue = Date.now() - (liveCache.soopAt || 0) > SOOP_TTL && Date.now() > (liveCache.soopPauseUntil || 0);
            let soopFailed = false;
            const [live, soop] = await Promise.all([
              refreshLive(ids, new Set(labels.map(([, l]) => ch[l.ytUrl] && ch[l.ytUrl].id).filter(Boolean))),
              soopDue ? refreshSoop(soopIds).catch((e) => { soopFailed = true; soopStat.err = String(e.message || e); return liveCache.soop || {}; }) : (liveCache.soop || {}),
            ]);
            liveCache = { at: Date.now(), live, soop,
              soopAt: soopDue ? Date.now() : liveCache.soopAt, soopStat: soopDue ? soopStat : liveCache.soopStat,
              soopPauseUntil: soopFailed ? Date.now() + 60 * 60 * 1000 : (liveCache.soopPauseUntil || 0) };
            await setJSON(LIVE_KEY, liveCache);
          }
        } finally { await redis(['DEL', LOCK_KEY]).catch(() => {}); }
      }
    }

    const out = {};
    for (const [id, m] of members) {
      const c = ch[m.channelUrl];
      const ok = c && !c.bad;
      const lv = ok && c.id && liveCache.live[c.id];
      const sid = m.soopUrl && parseSoop(m.soopUrl);
      const sv = !lv && sid && (liveCache.soop || {})[sid];
      if (!ok && !sv) continue;
      out[id] = { photo: ok ? (c.photo || '') : '', subs: ok ? (c.subs ?? null) : null,
        live: !!(lv || sv),
        liveUrl: lv ? `https://www.youtube.com/watch?v=${lv.videoId}` : sv ? `https://play.sooplive.co.kr/${sid}/${sv.broadNo}` : '',
        liveTitle: lv ? lv.title : sv ? sv.title : '',
        livePlatform: lv ? 'youtube' : sv ? 'soop' : '' };
    }
    const labelOut = {};
    for (const [id, l] of labels) {
      const c = ch[l.ytUrl];
      if (!c || c.bad) continue;
      const lv = c.id && liveCache.live[c.id];
      labelOut[id] = { photo: c.photo || '', subs: c.subs ?? null, live: !!lv, liveUrl: lv ? `https://www.youtube.com/watch?v=${lv.videoId}` : '', liveTitle: lv ? lv.title : '', thumb: lv ? lv.thumb : '' };
    }
    send(res, 200, { members: out, labels: labelOut, checkedAt: liveCache.at, soop: liveCache.soopStat || null, soopCheckedAt: liveCache.soopAt || null, soopPausedUntil: liveCache.soopPauseUntil > Date.now() ? liveCache.soopPauseUntil : null }, { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' });
  } catch (e) { send(res, 200, { members: {}, error: String(e.message || e) }); }
};
