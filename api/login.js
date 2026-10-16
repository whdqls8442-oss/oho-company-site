// POST /api/login {password} → 관리자 토큰
const crypto = require('crypto');
const { makeToken, readJSON, send, isAdmin } = require('./_lib');
module.exports = async (req, res) => {
  if (req.method === 'GET') return send(res, 200, { admin: isAdmin(req) });
  try {
    const { password } = await readJSON(req);
    const real = process.env.ADMIN_PASSWORD || '';
    if (!real) return send(res, 500, { error: 'Vercel 환경변수 ADMIN_PASSWORD가 설정되지 않았어요' });
    const a = crypto.createHash('sha256').update(String(password || '')).digest();
    const b = crypto.createHash('sha256').update(real).digest();
    if (!crypto.timingSafeEqual(a, b)) { await new Promise(r => setTimeout(r, 600)); return send(res, 401, { error: '비밀번호가 맞지 않아요' }); }
    send(res, 200, { token: makeToken() });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
};
