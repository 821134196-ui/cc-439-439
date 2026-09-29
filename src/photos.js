'use strict';
// 交接照片：保存到本地目录，数据库只存相对路径与元数据
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function photoDir() {
  return path.resolve(process.env.CARE_PHOTO_DIR || path.join('data', 'photos'));
}

function savePhoto(db, { refType, refId, data, ext = 'svg', mime = 'image/svg+xml' }) {
  if (!['return', 'cleaning', 'repair', 'transfer'].includes(refType))
    throw new Error('非法照片关联类型');
  const dir = photoDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${refType}-${refId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  const storedPath = path.join(dir, filename);
  fs.writeFileSync(storedPath, data);
  const r = db.prepare(
    `INSERT INTO photos(ref_type,ref_id,filename,stored_path,mime,size,uploaded_at)
     VALUES(?,?,?,?,?,?,?)`
  ).run(refType, refId, filename, path.relative(path.resolve('.'), storedPath), mime, data.length, new Date().toISOString());
  return db.prepare('SELECT * FROM photos WHERE id=?').get(Number(r.lastInsertRowid));
}

function listPhotos(db, refType = null, refId = null) {
  if (refType && refId != null)
    return db.prepare('SELECT * FROM photos WHERE ref_type=? AND ref_id=? ORDER BY id').all(refType, refId);
  return db.prepare('SELECT * FROM photos ORDER BY id DESC').all();
}
function absolutePath(row) {
  return path.isAbsolute(row.stored_path) ? row.stored_path : path.resolve(row.stored_path);
}

// 演示用占位照片（SVG），真实部署替换为手机拍照上传
function placeholderSvg(title, subtitle, color = '#1f6f8b') {
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
  <rect width="640" height="420" fill="#f4f8fb"/>
  <rect x="0" y="0" width="640" height="64" fill="${color}"/>
  <text x="28" y="42" font-family="sans-serif" font-size="24" fill="#ffffff">交接照片（演示占位）</text>
  <text x="28" y="150" font-family="sans-serif" font-size="30" fill="#16324f">${esc(title)}</text>
  <text x="28" y="200" font-family="sans-serif" font-size="20" fill="#3d5a72">${esc(subtitle)}</text>
  <g stroke="#9fc5d3" stroke-width="3" fill="none">
    <rect x="28" y="240" width="584" height="140" rx="10"/>
    <line x1="28" y1="310" x2="612" y2="310"/>
  </g>
  <text x="40" y="355" font-family="sans-serif" font-size="16" fill="#6a8296">本地目录保存 · data/photos · 拍摄时间以护士工作站为准</text>
</svg>`, 'utf8');
}

module.exports = { savePhoto, listPhotos, absolutePath, photoDir, placeholderSvg };
