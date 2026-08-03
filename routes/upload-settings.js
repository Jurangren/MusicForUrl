const express = require('express');
const router = express.Router();
const { userOps, qqUserOps, uploadCredentialOps } = require('../lib/db');
const { encrypt } = require('../lib/crypto');
const { TmpLinkClient } = require('../lib/tmplink');

const PROVIDER = 'tmplink';

function resolveAccount(req, res) {
  const source = String(req.query.source || req.body?.source || '').toLowerCase() === 'qq' ? 'qq' : 'netease';
  const headerName = source === 'qq' ? 'x-qq-token' : 'x-token';
  const accountToken = String(req.headers[headerName] || '');
  const store = source === 'qq' ? qqUserOps : userOps;
  const user = accountToken ? store.getByToken.get(accountToken) : null;
  if (!user) {
    res.status(401).json({ success: false, message: `${source === 'qq' ? 'QQ 音乐' : '网易云'}登录已失效` });
    return null;
  }
  return { source, user };
}

router.get('/tmplink', (req, res) => {
  const account = resolveAccount(req, res);
  if (!account) return;
  const saved = uploadCredentialOps.get.get(account.source, account.user.id, PROVIDER);
  res.json({
    success: true,
    data: saved ? {
      configured: true,
      uid: saved.remote_uid || '',
      expiresAt: saved.expires_at || null,
      updatedAt: saved.updated_at || null
    } : { configured: false, uid: '', expiresAt: null, updatedAt: null }
  });
});

router.put('/tmplink', async (req, res) => {
  const account = resolveAccount(req, res);
  if (!account) return;
  const token = String(req.body?.token || '').trim();
  if (!token || token.length > 8192) {
    return res.status(400).json({ success: false, message: '请输入有效的 TMPLINK Token' });
  }

  let client;
  try {
    client = new TmpLinkClient(token);
  } catch (error) {
    return res.status(400).json({ success: false, message: error?.message || 'TMPLINK Token 格式无效' });
  }

  try {
    const validation = await client.validateToken();
    if (!validation.valid) {
      return res.status(401).json({ success: false, message: `TMPLINK 验证未通过：${validation.reason || 'Token 被拒绝'}` });
    }
    uploadCredentialOps.set.run({
      source: account.source,
      user_id: account.user.id,
      provider: PROVIDER,
      encrypted_token: encrypt(token),
      remote_uid: validation.uid || '',
      expires_at: validation.expiresAt || null
    });
    res.json({
      success: true,
      message: 'TMPLINK Token 已通过服务器验证并安全保存',
      data: { configured: true, uid: validation.uid || '', expiresAt: validation.expiresAt || null }
    });
  } catch (error) {
    console.error('[TMPLINK] Token 远程验证失败:', error?.message || error);
    res.status(502).json({ success: false, message: `无法连接 TMPLINK 验证服务器：${error?.message || error}` });
  }
});

router.delete('/tmplink', (req, res) => {
  const account = resolveAccount(req, res);
  if (!account) return;
  uploadCredentialOps.delete.run(account.source, account.user.id, PROVIDER);
  res.json({ success: true, message: '已移除 TMPLINK Token' });
});

module.exports = router;
