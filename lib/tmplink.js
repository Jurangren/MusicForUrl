const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_API_BASE = 'https://connect.cntmp.link/api_v2';
const DEFAULT_WEB_BASE = 'https://www.ttttt.link';
const COMPLETE_STATUSES = new Set([1, 6, 8]);
const MERGING_STATUSES = new Set([2, 9]);

class TmpLinkError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'TmpLinkError';
    this.code = options.code || 'TMPLINK_ERROR';
    this.status = options.status;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeTokenClaims(token) {
  const value = String(token || '').trim();
  const parts = value.split('.');
  if (parts.length !== 3) throw new TmpLinkError('Token 格式无效，应为三段 JWT', { code: 'INVALID_TOKEN' });
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || payload.uid === undefined || payload.uid === null || String(payload.uid) === '') {
      throw new Error('missing uid');
    }
    if (Number.isFinite(Number(payload.exp)) && Number(payload.exp) * 1000 <= Date.now()) {
      throw new TmpLinkError('Token 已过期', { code: 'TOKEN_EXPIRED' });
    }
    return payload;
  } catch (error) {
    if (error instanceof TmpLinkError) throw error;
    throw new TmpLinkError('Token 载荷无效或缺少 uid', { code: 'INVALID_TOKEN' });
  }
}

function responseReason(payload, fallback) {
  const reason = payload?.data ?? payload?.debug;
  if (reason === undefined || reason === null || String(reason).trim() === '') return fallback;
  return typeof reason === 'string' ? reason : JSON.stringify(reason);
}

class TmpLinkClient {
  constructor(token, options = {}) {
    this.token = String(token || '').trim();
    this.claims = decodeTokenClaims(this.token);
    this.uid = String(this.claims.uid);
    this.apiBase = String(options.apiBase || process.env.TMPLINK_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '');
    this.webBase = String(options.webBase || process.env.TMPLINK_WEB_BASE || DEFAULT_WEB_BASE).replace(/\/$/, '');
    const configuredMiB = Number(process.env.TMPLINK_SLICE_SIZE_MIB);
    const defaultBytes = Number.isFinite(configuredMiB) && configuredMiB >= 1 && configuredMiB <= 80
      ? Math.round(configuredMiB * 1024 * 1024)
      : 80 * 1024 * 1024;
    this.sliceSize = Math.max(1024 * 1024, Math.min(80 * 1024 * 1024, Number(options.sliceSize) || defaultBytes));
    this.fetch = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new TmpLinkError('当前 Node.js 不支持 fetch');
  }

  async postForm(url, fields, context) {
    let response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)]))
      });
    } catch (error) {
      throw new TmpLinkError(`${context}网络请求失败：${error?.message || error}`, { code: 'NETWORK_ERROR' });
    }
    return this.parseJson(response, context);
  }

  async parseJson(response, context) {
    let payload;
    let preview = '';
    try {
      preview = await response.text();
      payload = JSON.parse(preview);
    } catch (_) {
      throw new TmpLinkError(`${context}返回了无效数据：${preview.slice(0, 160)}`, { status: response.status });
    }
    if (!response.ok) {
      throw new TmpLinkError(`${context}失败（HTTP ${response.status}）：${responseReason(payload, '服务器拒绝请求')}`, {
        status: response.status,
        code: response.status === 401 || response.status === 403 ? 'TOKEN_REJECTED' : 'HTTP_ERROR'
      });
    }
    if (!payload || typeof payload !== 'object') throw new TmpLinkError(`${context}响应格式无效`);
    return payload;
  }

  apiActionRaw(endpoint, action, fields = {}) {
    return this.postForm(`${this.apiBase}/${endpoint}`, { action, token: this.token, ...fields }, `TMPLINK ${action} `);
  }

  async apiAction(endpoint, action, fields = {}) {
    const payload = await this.apiActionRaw(endpoint, action, fields);
    if (Number(payload.status) !== 1) {
      throw new TmpLinkError(`TMPLINK ${action} 失败：${responseReason(payload, `status=${payload.status}`)}`);
    }
    return payload.data;
  }

  async validateToken() {
    let payload;
    try {
      payload = await this.apiActionRaw('user', 'get_detail');
    } catch (error) {
      if (error?.code === 'TOKEN_REJECTED') {
        return { valid: false, uid: this.uid, reason: 'Token 被服务器拒绝' };
      }
      throw error;
    }
    if (Number(payload.status) !== 1) {
      return { valid: false, uid: this.uid, reason: responseReason(payload, 'Token 被服务器拒绝') };
    }
    return {
      valid: true,
      uid: this.uid,
      expiresAt: Number.isFinite(Number(this.claims.exp)) ? new Date(Number(this.claims.exp) * 1000).toISOString() : null
    };
  }

  async requestUploadServers(filesize) {
    const data = await this.apiAction('file', 'upload_request_select2', { filesize });
    const servers = Array.isArray(data?.servers)
      ? data.servers.map((item) => String(item?.url || '').replace(/\/$/, '')).filter(Boolean)
      : [];
    if (!data?.utoken || servers.length === 0) throw new TmpLinkError('TMPLINK 未返回可用的上传节点');
    return { utoken: String(data.utoken), servers: [...new Set(servers)] };
  }

  async probeUploadServers(servers, options = {}) {
    const unique = [...new Set((servers || []).map((server) => String(server).replace(/\/$/, '')).filter(Boolean))];
    if (unique.length <= 1) return unique;
    const timeoutMs = Math.max(1000, Math.min(10000, Number(options.probeTimeoutMs) || 5000));
    const scores = await Promise.all(unique.map(async (server, index) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const response = await this.fetch(`${server}/app/upload_slice?_probe=${Date.now()}-${index}`, {
          method: 'HEAD',
          signal: controller.signal
        });
        return { server, latency: response.ok ? Date.now() - startedAt : Number.POSITIVE_INFINITY };
      } catch (_) {
        return { server, latency: Number.POSITIVE_INFINITY };
      } finally {
        clearTimeout(timer);
      }
    }));
    return scores.sort((left, right) => left.latency - right.latency).map((item) => item.server);
  }

  async uploadNodeForm(servers, fields, context, chunk = null) {
    const failures = [];
    for (let serverIndex = 0; serverIndex < servers.length; serverIndex++) {
      const server = servers[serverIndex];
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          let response;
          if (chunk) {
            const form = new FormData();
            for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
            form.append('filedata', new Blob([chunk], { type: 'application/octet-stream' }), 'slice');
            response = await this.fetch(`${server}/app/upload_slice`, { method: 'POST', body: form });
          } else {
            response = await this.fetch(`${server}/app/upload_slice`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
              body: new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)]))
            });
          }
          const payload = await this.parseJson(response, context);
          return { payload, servers: [server, ...servers.filter((item) => item !== server)] };
        } catch (error) {
          failures.push(`${server} 第${attempt}次：${error?.message || error}`);
          if (attempt < 2) await sleep(500);
        }
      }
    }
    throw new TmpLinkError(`所有 TMPLINK 上传节点均不可用：${failures.join('；')}`);
  }

  async uploadFile(filePath, options = {}) {
    const resolved = path.resolve(filePath);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile() || stat.size <= 0) throw new TmpLinkError('待上传视频不存在或为空');
    const filename = String(options.filename || path.basename(resolved));
    const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    progress({ phase: 'preparing', percent: 2, message: '正在申请 TMPLINK 上传节点' });
    let { utoken, servers } = await this.requestUploadServers(stat.size);
    if (options.probe !== false && servers.length > 1) {
      progress({ phase: 'preparing', percent: 3, message: `正在测速选择最快上传节点（${servers.length} 个）` });
      servers = await this.probeUploadServers(servers, options);
    }
    progress({ phase: 'preparing', percent: 4, message: '已选择最快上传节点' });
    const uptoken = crypto.createHash('sha1')
      .update(`${this.uid}${filename}${stat.size}${this.sliceSize}`, 'utf8')
      .digest('hex');
    const prepareFields = {
      token: this.token,
      uptoken,
      action: 'prepare',
      sha1: '0',
      filename,
      filesize: stat.size,
      slice_size: this.sliceSize,
      utoken,
      mr_id: 0,
      model: options.model || 2
    };
    let mergePolls = 0;
    let lastIndex = null;
    let staleCount = 0;
    const handle = await fs.promises.open(resolved, 'r');
    try {
      while (true) {
        const prepared = await this.uploadNodeForm(servers, prepareFields, 'TMPLINK 准备上传');
        servers = prepared.servers;
        const payload = prepared.payload;
        const status = Number(payload.status);
        const data = payload.data;
        if (COMPLETE_STATUSES.has(status)) {
          const ukey = String(data || '');
          if (!ukey) throw new TmpLinkError('上传完成但 TMPLINK 未返回文件标识');
          progress({ phase: 'merging', percent: 92, message: '视频上传完成，正在生成公开链接' });
          return ukey;
        }
        if (status === 7) throw new TmpLinkError(`TMPLINK 拒绝上传：${responseReason(payload, '未知原因')}`, { code: 'UPLOAD_REJECTED' });
        if (MERGING_STATUSES.has(status)) {
          mergePolls += 1;
          if (mergePolls > 300) throw new TmpLinkError('等待 TMPLINK 合并文件超时');
          progress({ phase: 'merging', percent: Math.min(94, 90 + Math.floor(mergePolls / 10)), message: '正在合并远端视频文件' });
          await sleep(Number(options.mergePollIntervalMs) || 1000);
          continue;
        }
        if (status !== 3 || !data || typeof data !== 'object') {
          throw new TmpLinkError(`TMPLINK 返回未知上传状态：${status}`);
        }
        const index = Number(data.next);
        const total = Number(data.total);
        const wait = Number(data.wait);
        if (!Number.isInteger(index) || !Number.isInteger(total) || total <= 0 || index < 0 || index >= total) {
          throw new TmpLinkError('TMPLINK 返回了无效的分片位置');
        }
        if (wait <= 0 && index === lastIndex) {
          staleCount += 1;
          if (staleCount > 5) throw new TmpLinkError(`TMPLINK 连续要求重复上传第 ${index + 1} 片`);
        } else {
          staleCount = 0;
        }
        lastIndex = index;
        const offset = index * this.sliceSize;
        const expected = Math.min(this.sliceSize, stat.size - offset);
        const chunk = Buffer.allocUnsafe(expected);
        const { bytesRead } = await handle.read(chunk, 0, expected, offset);
        if (bytesRead !== expected) throw new TmpLinkError(`读取视频第 ${index + 1} 个分片失败`);
        progress({
          phase: 'uploading',
          percent: Math.max(5, Math.min(89, 5 + Math.round(index / total * 84))),
          message: `正在上传视频 ${index + 1}/${total}`
        });
        const uploaded = await this.uploadNodeForm(servers, {
          uptoken,
          filename,
          index,
          action: 'upload_slice',
          slice_size: this.sliceSize
        }, `TMPLINK 上传第 ${index + 1} 片`, chunk);
        servers = uploaded.servers;
        if (Number(uploaded.payload.status) === 7) {
          throw new TmpLinkError(`TMPLINK 拒绝视频分片：${responseReason(uploaded.payload, '未知原因')}`, { code: 'UPLOAD_REJECTED' });
        }
        progress({
          phase: 'uploading',
          percent: Math.max(6, Math.min(90, 5 + Math.round((index + 1) / total * 84))),
          message: `已上传视频 ${index + 1}/${total}`
        });
      }
    } finally {
      await handle.close();
    }
  }

  async getDirectUrl(ukey, options = {}) {
    const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const deadline = Date.now() + (Number(options.waitMs) || 300000);
    let polls = 0;
    while (true) {
      const payload = await this.apiActionRaw('file', 'download_req', { ukey });
      if (Number(payload.status) === 1 && /^https?:\/\//i.test(String(payload.data || ''))) return String(payload.data);
      if (Number(payload.status) !== 2 || Date.now() >= deadline) {
        throw new TmpLinkError(Number(payload.status) === 2
          ? '等待 TMPLINK 公开直链生成超时'
          : `TMPLINK 获取直链失败：${responseReason(payload, `status=${payload.status}`)}`);
      }
      polls += 1;
      progress({ phase: 'resolving', percent: Math.min(99, 95 + Math.floor(polls / 5)), message: '文件已上传，正在等待公开直链' });
      await sleep(Number(options.pollIntervalMs) || 5000);
    }
  }

  async uploadAndGetDirectUrl(filePath, options = {}) {
    const onProgress = options.onProgress;
    const ukey = await this.uploadFile(filePath, options);
    if (onProgress) onProgress({ phase: 'resolving', percent: 95, message: '正在获取公开直链' });
    const directUrl = await this.getDirectUrl(ukey, { ...options, onProgress });
    if (onProgress) onProgress({ phase: 'completed', percent: 100, message: '公开链接已生成' });
    return { file: path.resolve(filePath), ukey, shareUrl: `${this.webBase}/file/${encodeURIComponent(ukey)}`, directUrl };
  }
}

module.exports = { TmpLinkClient, TmpLinkError, decodeTokenClaims };
