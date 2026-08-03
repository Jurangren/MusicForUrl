const http = require('http');
const https = require('https');

function isAllowedTmpLinkHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'ttttt.link' || host.endsWith('.ttttt.link') ||
    host === 'cntmp.link' || host.endsWith('.cntmp.link') ||
    host === 'vx-cdn.com' || host.endsWith('.vx-cdn.com');
}

function probePublicLink(rawUrl, options = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch (_) {
    return Promise.resolve({ valid: false, statusCode: null, error: '公开链接格式无效' });
  }
  if (!['http:', 'https:'].includes(url.protocol) || !isAllowedTmpLinkHost(url.hostname)) {
    return Promise.resolve({ valid: false, statusCode: null, error: '不是受支持的 TMPLINK 公开链接' });
  }

  const timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs) || 8000));
  const transport = url.protocol === 'https:' ? https : http;
  const requestImpl = options.requestImpl || transport.request;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, checkedAt: new Date().toISOString() });
    };
    const request = requestImpl(url, {
      method: 'HEAD',
      headers: {
        Accept: '*/*',
        'User-Agent': 'MusicForUrl-LinkHealth/1.0'
      }
    }, (response) => {
      const statusCode = Number(response.statusCode) || null;
      response.resume?.();
      finish({
        valid: statusCode === 200,
        statusCode,
        error: statusCode === 200 ? '' : `HTTP ${statusCode || '未知'}`
      });
    });
    request.setTimeout?.(timeoutMs, () => request.destroy(new Error('链接检测超时')));
    request.on('error', (error) => finish({ valid: false, statusCode: null, error: error?.message || '链接检测失败' }));
    request.end();
  });
}

module.exports = { isAllowedTmpLinkHost, probePublicLink };
