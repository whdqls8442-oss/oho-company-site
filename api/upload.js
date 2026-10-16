// POST /api/upload?type=image/jpeg  (본문 = 이미지 파일, 관리자 전용) → {url}
const { put } = require('@vercel/blob');
const crypto = require('crypto');
const { isAdmin, readBody, send } = require('./_lib');
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST만 가능해요' });
  if (!isAdmin(req)) return send(res, 401, { error: '관리자 로그인이 필요해요' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return send(res, 500, { error: 'Vercel Blob 저장소가 연결되지 않았어요' });
  try {
    const type = String((req.query && req.query.type) || '').toLowerCase();
    const ext = TYPES[type];
    if (!ext) return send(res, 400, { error: 'PNG·JPG·WEBP·GIF 이미지만 올릴 수 있어요' });
    const buf = await readBody(req, 4.4 * 1024 * 1024);
    if (!buf.length) return send(res, 400, { error: '빈 파일이에요' });
    const name = `oho/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const blob = await put(name, buf, { access: 'public', contentType: type });
    send(res, 200, { url: blob.url });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
};
