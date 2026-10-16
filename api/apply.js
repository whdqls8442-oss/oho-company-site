// POST /api/apply {id, data} → 지원서 접수 (누구나). 같은 id로 다시 내면 덮어씀
const { getJSON, setJSON, readJSON, send, APPS_KEY } = require('./_lib');
const ID = /^[A-Za-z0-9_\-]{8,64}$/;
const S = (v, n) => String(v ?? '').slice(0, n);
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST만 가능해요' });
  try {
    const { id, data = {} } = await readJSON(req);
    if (!ID.test(id || '')) return send(res, 400, { error: '잘못된 요청이에요' });
    if (!data.name || !data.phone || !data.intro || !data.agree) return send(res, 400, { error: '필수 항목을 채워주세요' });
    const apps = await getJSON(APPS_KEY, {});
    if (!apps[id] && Object.keys(apps).length > 3000) return send(res, 429, { error: '접수가 많아 잠시 후 다시 시도해 주세요' });
    const prev = apps[id] || {};
    apps[id] = {
      name: S(data.name, 40), phone: S(data.phone, 20), birthYear: S(data.birthYear, 4), labelWish: S(data.labelWish, 60),
      platform: S(data.platform, 40), career: S(data.career, 40), channelUrl: S(data.channelUrl, 300),
      days: Array.isArray(data.days) ? data.days.slice(0, 7).map(d => S(d, 2)) : [], intro: S(data.intro, 2000), agree: true,
      status: prev.status || 'new', createdAt: prev.createdAt || Date.now(), updatedAt: Date.now(),
    };
    await setJSON(APPS_KEY, apps);
    send(res, 200, { ok: true });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
};
