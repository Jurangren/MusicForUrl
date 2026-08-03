const { ensureEnvFile } = require('./lib/env-check');
ensureEnvFile();
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const { getKey } = require('./lib/crypto');
const { createSiteAccess } = require('./lib/site-access');
require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

const trustProxy = process.env.TRUST_PROXY;
let proxyValue = 'loopback';

if (trustProxy !== undefined && trustProxy !== null && String(trustProxy).trim() !== '') {
  const normalized = String(trustProxy).trim();

  if (normalized === 'false' || normalized === '0') {
    proxyValue = false;
  } else if (normalized === 'true') {
    proxyValue = 1;
    console.warn('[WARN] TRUST_PROXY=true 会信任所有代理，已自动改用 TRUST_PROXY=1；请按实际代理层数设置 TRUST_PROXY=1/2/3... 或指定代理 IP/子网。');
  } else if (/^\d+$/.test(normalized)) {
    proxyValue = parseInt(normalized, 10);
  } else {
    proxyValue = normalized;
  }
}

app.set('trust proxy', proxyValue);

app.use(cors());
app.use(compression({
  filter: (req, res) => {
    const ct = res.getHeader('Content-Type') || '';
    // M3U8 播放列表不压缩，避免部分播放器（如 VLC）无法解码 gzip 响应
    if (String(ct).includes('mpegurl')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

const SITE_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const siteAccess = createSiteAccess({ cookieSigningKey: getKey() });

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const parts = String(cookieHeader).split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch (_) { out[key] = value; }
  }
  return out;
}

function setSiteAccessCookie(req, res) {
  res.cookie(siteAccess.cookieName, siteAccess.cookieValue(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SITE_COOKIE_MAX_AGE_MS
  });
}

function isPublicAssetPath(p) {
  if (p === '/password.html') return true;
  if (p === '/placeholder.svg' || p === '/favicon.ico') return true;
  if (p === '/css/style.css' || p === '/css/password.css' || p === '/js/password.js' || p === '/js/error-utils.js') return true;
  return false;
}

function isPublicPlaybackPath(p) {
  if (p.startsWith('/api/playlist/') && p.endsWith('.m3u8')) return true;
  if (p.startsWith('/api/song/')) return true;
  if (p.startsWith('/api/hls/') && !p.startsWith('/api/hls/cache')) return true;
  if (p.startsWith('/api/qq/hls/') && !p.startsWith('/api/qq/hls/cache')) return true;
  if (p.startsWith('/api/mp4/') || p.startsWith('/api/qq/mp4/')) return true;
  if (p.startsWith('/api/playlist-video/') || p.startsWith('/api/qq/playlist-video/')) return true;
  if (p.startsWith('/api/qq/song/')) return true;
  if (p.startsWith('/api/qq/playlist/m3u8/') && p.endsWith('.m3u8')) return true;
  return false;
}

app.get('/api/site-access/status', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  res.json({
    success: true,
    configured: siteAccess.configured(),
    authenticated: siteAccess.isCookieValid(cookies[siteAccess.cookieName]),
    source: siteAccess.source(),
    minSecretLength: siteAccess.minSecretLength
  });
});

app.post('/api/site-access/setup', (req, res) => {
  try {
    const secret = String(req.body?.secret || '');
    siteAccess.setup(secret);
    setSiteAccessCookie(req, res);
    res.status(201).json({ success: true, message: '后台密钥设置成功' });
  } catch (error) {
    if (error?.code === 'ALREADY_CONFIGURED') {
      return res.status(409).json({ success: false, message: error.message });
    }
    res.status(400).json({ success: false, message: error?.message || '后台密钥设置失败' });
  }
});

app.post('/api/site-access/login', (req, res) => {
  if (!siteAccess.configured()) {
    return res.status(428).json({ success: false, message: '请先设置后台密钥' });
  }
  const secret = String(req.body?.secret || req.headers['x-site-password'] || '');
  if (!siteAccess.verify(secret)) {
    return res.status(401).json({ success: false, message: '后台密钥错误' });
  }
  setSiteAccessCookie(req, res);
  res.json({ success: true, message: '登录成功' });
});

app.post('/api/site-access/logout', (req, res) => {
  res.clearCookie(siteAccess.cookieName, { httpOnly: true, sameSite: 'lax', secure: req.secure });
  res.json({ success: true });
});

app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/api/site-access/')) return next();
  if (isPublicPlaybackPath(req.path) || isPublicAssetPath(req.path)) return next();

  const cookies = parseCookies(req.headers.cookie);
  if (siteAccess.isCookieValid(cookies[siteAccess.cookieName])) return next();

  // 兼容旧客户端：携带环境变量 SITE_PASSWORD 时仍可换取登录 Cookie。
  const provided = req.headers['x-site-password'] || req.query.sitePassword;
  if (provided && siteAccess.verify(provided)) {
    setSiteAccessCookie(req, res);
    return next();
  }

  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, 'public', 'password.html'));
  }

  const status = siteAccess.configured() ? 401 : 428;
  return res.status(status).json({
    success: false,
    configured: siteAccess.configured(),
    message: siteAccess.configured() ? '需要后台密钥登录' : '请先设置后台密钥'
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/playlist', require('./routes/playlist'));

app.use('/api/song', require('./routes/song'));
app.use('/api/img', require('./routes/img'));
app.use('/api/hls', require('./routes/hls'));
app.use('/api/qq/hls', require('./routes/hls'));
app.use('/api/playlist-video', require('./routes/hls'));
app.use('/api/qq/playlist-video', require('./routes/hls'));
app.use('/api/mp4', require('./routes/mp4'));
app.use('/api/qq/mp4', require('./routes/mp4'));
app.use('/api/favorites', require('./routes/favorite'));
app.use('/api/history', require('./routes/history'));
app.use('/api/upload-settings', require('./routes/upload-settings'));
app.use('/api/generation-history', require('./routes/generation-history'));

app.use('/api/qq/auth', require('./routes/qq-auth'));
app.use('/api/qq/playlist', require('./routes/qq-playlist'));
app.use('/api/qq/favorites', require('./routes/qq-favorite'));
app.use('/api/qq/history', require('./routes/qq-history'));
app.use('/api/qq/song', require('./routes/qq-song'));

app.use('/api', (req, res) => {
  res.status(404).json({ 
    success: false, 
    message: '接口不存在',
    path: req.path,
    method: req.method
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ success: false, message: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`
服务器已经启动，端口号为${PORT}      
  `);
});

module.exports = app;
