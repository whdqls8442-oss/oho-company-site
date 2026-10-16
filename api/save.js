// POST /api/save  {op:'set'|'update'|'delete', col, id, data}  (관리자 전용)
const { loadData, saveData, getJSON, setJSON, isAdmin, readJSON, send, COLLECTIONS, APPS_KEY } = require('./_lib');
const ID = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST만 가능해요' });
  if (!isAdmin(req)) return send(res, 401, { error: '관리자 로그인이 필요해요' });
  try {
    const { op, col, id, data } = await readJSON(req);
    if (!ID.test(id || '')) return send(res, 400, { error: '잘못된 id' });
    if (col === 'applications') {
      const apps = await getJSON(APPS_KEY, {});
      if (op === 'delete') delete apps[id];
      else if (op === 'update') { if (!apps[id]) return send(res, 404, { error: '없는 지원서' }); apps[id] = { ...apps[id], ...data }; }
      else apps[id] = data;
      await setJSON(APPS_KEY, apps);
      return send(res, 200, { ok: true });
    }
    if (!COLLECTIONS.includes(col)) return send(res, 400, { error: '잘못된 항목' });
    const d = await loadData();
    if (op === 'delete') delete d[col][id];
    else if (op === 'update') { if (!d[col][id]) return send(res, 404, { error: '없는 항목' }); d[col][id] = { ...d[col][id], ...data }; }
    else if (op === 'set') d[col][id] = data || {};
    else return send(res, 400, { error: '잘못된 요청' });
    await saveData(d);
    send(res, 200, { ok: true });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
};
