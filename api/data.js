// GET /api/data → 사이트 전체 내용 (관리자는 지원서 목록 포함)
const { loadData, getJSON, isAdmin, send, storeReady, APPS_KEY } = require('./_lib');
module.exports = async (req, res) => {
  try {
    const data = await loadData();
    const admin = isAdmin(req);
    if (admin) data.applications = await getJSON(APPS_KEY, {});
    send(res, 200, { data, admin, storeReady: storeReady() }, { 'Cache-Control': 'no-store' });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
};
