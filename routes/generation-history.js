const express = require('express');
const router = express.Router();
const { userOps, qqUserOps, generationHistoryOps } = require('../lib/db');
const { probePublicLink } = require('../lib/public-link-health');

function resolveAccount(req, res) {
  const source = String(req.query.source || '').toLowerCase() === 'qq' ? 'qq' : 'netease';
  const headerName = source === 'qq' ? 'x-qq-token' : 'x-token';
  const token = String(req.headers[headerName] || '');
  const store = source === 'qq' ? qqUserOps : userOps;
  const user = token ? store.getByToken.get(token) : null;
  if (!user) {
    res.status(401).json({ success: false, message: `${source === 'qq' ? 'QQ 音乐' : '网易云'}登录已失效` });
    return null;
  }
  return { source, user };
}

router.get('/', (req, res) => {
  const account = resolveAccount(req, res);
  if (!account) return;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 10));
  const offset = (page - 1) * limit;
  const rows = generationHistoryOps.list.all(account.source, account.user.id, limit, offset);
  const total = generationHistoryOps.count.get(account.source, account.user.id)?.count || 0;
  res.json({
    success: true,
    data: rows.map((row) => ({
      jobId: row.job_id,
      source: row.source,
      playlistId: row.playlist_id,
      playlistName: row.playlist_name || '未命名歌单',
      playlistCover: row.playlist_cover || '',
      playlistCreator: row.playlist_creator || '未知作者',
      generatedAt: row.generated_at,
      generationSeconds: Math.max(0, Number(row.generation_seconds) || 0),
      publicUrl: row.public_url || '',
      localPath: row.local_path || '',
      uploadStatus: row.upload_status || ''
    })),
    total,
    page,
    limit
  });
});

router.post('/:jobId/check-link', async (req, res) => {
  const account = resolveAccount(req, res);
  if (!account) return;
  const row = generationHistoryOps.getOwned.get(String(req.params.jobId || ''), account.source, account.user.id);
  if (!row) return res.status(404).json({ success: false, message: '历史生成记录不存在' });
  if (!row.public_url) {
    return res.json({ success: true, data: { valid: false, statusCode: null, error: '尚无公开链接', checkedAt: new Date().toISOString() } });
  }
  const result = await probePublicLink(row.public_url);
  res.json({ success: true, data: result });
});

module.exports = router;
