// GET /api/youtube → 멤버별 유튜브 프로필 사진·구독자 수·라이브 여부
// - 채널 정보(사진·구독자)는 6시간마다 갱신
// - 라이브 여부는 90초마다 갱신 (채널 RSS로 최근 영상을 찾고, videos API로 '방송 중'인지 확인)
// 하루 사용량: 멤버 30명 기준 약 3,000~4,000 단위 (무료 한도 10,000)
const { loadData, getJSON, setJSON, redis, send } = require('./_lib');

const KEY = process.env.YOUTUBE_API_KEY;
const API = 'https://www.googleapis.com/youtube/v3';
const CH_KEY = 'oho:yt:ch', LIVE_KEY = 'oho:yt:live', LOCK_KEY = 'oho:yt:lock';
const CH_TTL = 6 * 3600 * 1000, LIVE_TTL = 90 * 1000;

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

async function recentVideoIds(channelId) {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const xml = await r.text();
    return [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].slice(0, 5).map(m => m[1]);
  } catch { return []; }
}

async function refreshLive(channelIds) {
  const lists = await Promise.all(channelIds.map(async id => [id, await recentVideoIds(id)]));
  const vidToCh = {};
  for (const [ch, vids] of lists) for (const v of vids) vidToCh[v] = ch;
  const vids = Object.keys(vidToCh), live = {};
  for (let i = 0; i < vids.length; i += 50) {
    const j = await yt('videos', { part: 'snippet', id: vids.slice(i, i + 50).join(',') });
    for (const v of j.items || []) {
      if (v.snippet.liveBroadcastContent === 'live') live[vidToCh[v.id]] = { videoId: v.id, title: v.snippet.title };
    }
  }
  return live;
}

module.exports = async (req, res) => {
  if (!KEY) return send(res, 200, { disabled: true, members: {} });
  try {
    const data = await loadData();
    const members = Object.entries(data.members || {});
    const urls = [...new Set(members.map(([, m]) => m.channelUrl).filter(u => u && /youtube\.com/.test(u)))];

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
            liveCache = { at: Date.now(), live: await refreshLive(ids) };
            await setJSON(LIVE_KEY, liveCache);
          }
        } finally { await redis(['DEL', LOCK_KEY]).catch(() => {}); }
      }
    }

    const out = {};
    for (const [id, m] of members) {
      const c = ch[m.channelUrl];
      if (!c || c.bad) continue;
      const lv = c.id && liveCache.live[c.id];
      out[id] = { photo: c.photo || '', subs: c.subs ?? null, live: !!lv, liveUrl: lv ? `https://www.youtube.com/watch?v=${lv.videoId}` : '', liveTitle: lv ? lv.title : '' };
    }
    send(res, 200, { members: out, checkedAt: liveCache.at }, { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' });
  } catch (e) { send(res, 200, { members: {}, error: String(e.message || e) }); }
};
