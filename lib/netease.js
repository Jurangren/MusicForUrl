const crypto = require('crypto');
const {
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  captcha_sent,
  login_cellphone,
  user_playlist,
  user_subcount,
  playlist_detail,
  song_detail,
  song_url,
  lyric
} = require('NeteaseCloudMusicApi');

async function withRetry(fn, { maxAttempts = 3, delayMs = 500 } = {}) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxAttempts) throw err;
      const isRetryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|502|503/.test(
        err?.message || String(err?.status)
      );
      if (!isRetryable) throw err;
      await new Promise(r => setTimeout(r, delayMs * i));
    }
  }
}

function normalizeCookie(cookie) {
  if (!cookie) return '';
  if (Array.isArray(cookie)) return cookie.join('; ');
  return String(cookie);
}

function getArtists(track) {
  const artists = track?.ar || track?.artists || [];
  return artists.map(a => a?.name).filter(Boolean).join('/');
}

function getDurationSeconds(track) {
  const ms = track?.dt ?? track?.duration ?? 0;
  const sec = Math.round(Number(ms) / 1000);
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

function getTrackCoverUrl(track) {
  const url =
    track?.al?.picUrl ??
    track?.album?.picUrl ??
    track?.picUrl ??
    track?.cover ??
    '';
  return url ? String(url) : '';
}

async function createQRCode() {
  const keyRes = await login_qr_key({ timestamp: Date.now() });
  if (keyRes?.body?.code !== 200 || !keyRes?.body?.data?.unikey) {
    throw new Error(keyRes?.body?.message || '获取二维码 key 失败');
  }

  const key = keyRes.body.data.unikey;
  const createRes = await login_qr_create({ key, qrimg: true, timestamp: Date.now() });
  if (createRes?.body?.code !== 200 || !createRes?.body?.data?.qrimg) {
    throw new Error(createRes?.body?.message || '生成二维码失败');
  }

  return { key, qrimg: createRes.body.data.qrimg };
}

async function checkQRCode(key) {
  try {
    const res = await withRetry(
      () => login_qr_check({ key, timestamp: Date.now() }),
      { maxAttempts: 2, delayMs: 300 }
    );
    const body = res?.body || {};
    return {
      code: body.code,
      message: body.message,
      cookie: normalizeCookie(body.cookie || res?.cookie)
    };
  } catch (err) {
    console.error('检查二维码状态失败:', err);
    return { code: -1, message: '二维码检查服务异常，请重试' };
  }
}

async function checkLoginStatus(cookie) {
  const res = await login_status({ cookie: normalizeCookie(cookie), timestamp: Date.now() });
  const data = res?.body?.data || {};
  const profile = data.profile;
  const account = data.account;

  if (!profile || !account) {
    return { logged: false };
  }

  return {
    logged: true,
    userId: profile.userId ?? account.id,
    nickname: profile.nickname,
    avatar: profile.avatarUrl,
    vipType: profile.vipType ?? 0
  };
}

async function sendCaptcha(phone) {
  const res = await captcha_sent({ phone, timestamp: Date.now() });
  return res?.body?.code === 200;
}

async function loginWithCaptcha(phone, captcha) {
  const res = await login_cellphone({ phone, captcha, timestamp: Date.now() });
  const body = res?.body || {};
  if (body.code !== 200) {
    throw new Error(body.message || '验证码登录失败');
  }
  const cookie = normalizeCookie(res?.cookie || body.cookie);
  if (!cookie) throw new Error('登录成功但未获取到 cookie');
  return { cookie };
}

async function loginWithPassword(phone, password) {
  const md5 = crypto.createHash('md5').update(String(password)).digest('hex');
  const res = await login_cellphone({ phone, md5_password: md5, timestamp: Date.now() });
  const body = res?.body || {};
  if (body.code !== 200) {
    throw new Error(body.message || '密码登录失败');
  }
  const cookie = normalizeCookie(res?.cookie || body.cookie);
  if (!cookie) throw new Error('登录成功但未获取到 cookie');
  return { cookie };
}

async function getUserPlaylists(uid, cookie = '', offset = 0, limit = 30) {
  const res = await user_playlist({
    uid,
    limit,
    offset,
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  });

  if (res?.body?.code !== 200) {
    throw new Error(res?.body?.message || '获取用户歌单失败');
  }

  const playlists = res.body.playlist?.map(p => ({
    id: p.id,
    name: p.name,
    cover: p.coverImgUrl,
    trackCount: p.trackCount,
    creator: p.creator?.nickname,
    userId: p.userId,
    playCount: p.playCount
  })) || [];

  let total = 0;
  
  if (res.body.playlistCount !== undefined) {
    total = res.body.playlistCount;
  } else if (res.body.more) {
    total = offset + playlists.length + limit;
  } else {
    total = offset + playlists.length;
  }

  return {
    playlists,
    hasMore: res.body.more,
    count: total
  };
}

async function getPlaylistDetail(playlistId, cookie = '') {
  const res = await withRetry(() => playlist_detail({
    id: playlistId,
    s: 8,
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  }));

  if (res?.body?.code !== 200 || !res?.body?.playlist) {
    throw new Error(res?.body?.message || '获取歌单失败');
  }

  const p = res.body.playlist;
  const tracks = (p.tracks || []).map(t => ({
    id: t.id,
    name: t.name,
    subtitle: Array.isArray(t.alia) ? t.alia.filter(Boolean).join(' / ') : '',
    album: t?.al?.name || t?.album?.name || '',
    artist: getArtists(t),
    duration: getDurationSeconds(t),
    cover: getTrackCoverUrl(t)
  }));

  return {
    id: p.id,
    name: p.name,
    cover: p.coverImgUrl,
    creator: p.creator?.nickname || '',
    songCount: p.trackCount || tracks.length,
    tracks
  };
}

const QUALITY_LEVELS = {
  low: 128000,
  medium: 192000,
  high: 320000,
  lossless: 999000
};
const DEFAULT_MUSIC_QUALITY = 'high';

function resolveSongUrlResponse(res, songId) {
  if (res?.body?.code !== 200) return null;
  const item = res?.body?.data?.[0];
  if (item?.url) return String(item.url);
  if (Number(item?.code) === 404) {
    const error = new Error(`歌曲 ${songId} 当前不可播放（网易状态码 404）`);
    error.code = 'SONG_UNPLAYABLE';
    error.source = 'netease';
    error.songId = String(songId);
    error.upstreamCode = 404;
    throw error;
  }
  return null;
}

async function getSongUrl(songId, cookie = '', quality = DEFAULT_MUSIC_QUALITY) {
  const selectedQuality = Object.hasOwn(QUALITY_LEVELS, quality) && quality !== 'lossless'
    ? quality
    : DEFAULT_MUSIC_QUALITY;
  const br = QUALITY_LEVELS[selectedQuality];
  const res = await withRetry(() => song_url({
    id: songId,
    br,
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  }));

  return resolveSongUrlResponse(res, songId);
}

async function getSongDetail(songId, cookie = '') {
  const res = await withRetry(() => song_detail({
    ids: String(songId),
    cookie: normalizeCookie(cookie),
    timestamp: Date.now()
  }));
  const track = res?.body?.songs?.[0];
  if (res?.body?.code !== 200 || !track) {
    throw new Error(res?.body?.message || '获取单曲详情失败');
  }

  return {
    id: String(track.id || songId),
    name: track.name || '',
    subtitle: Array.isArray(track.alia) ? track.alia.filter(Boolean).join(' / ') : '',
    album: track?.al?.name || track?.album?.name || '',
    artist: getArtists(track),
    duration: getDurationSeconds(track),
    cover: getTrackCoverUrl(track)
  };
}

async function getLyrics(songId, cookie = '') {
  try {
    const res = await withRetry(() => lyric({
      id: songId,
      cookie: normalizeCookie(cookie),
      timestamp: Date.now()
    }), { maxAttempts: 2, delayMs: 300 });
    return {
      original: String(res?.body?.lrc?.lyric || ''),
      translation: String(res?.body?.tlyric?.lyric || '')
    };
  } catch (error) {
    console.warn(`[网易歌词] 获取失败 songId=${songId}:`, error?.message || error);
    return { original: '', translation: '' };
  }
}

module.exports = {
  createQRCode,
  checkQRCode,
  checkLoginStatus,
  sendCaptcha,
  loginWithCaptcha,
  loginWithPassword,
  getUserPlaylists,
  getPlaylistDetail,
  getSongDetail,
  getSongUrl,
  resolveSongUrlResponse,
  getLyrics,
  QUALITY_LEVELS,
  DEFAULT_MUSIC_QUALITY
};
