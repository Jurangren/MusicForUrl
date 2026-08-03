const crypto = require('crypto');

function parseNeteaseSongId(input) {
  const value = String(input || '').trim();
  if (!value || !/(?:\/|#)song(?:\/|[?#]|$)/i.test(value)) return null;

  const pathMatch = value.match(/\/song\/(\d{1,20})(?:[/?#]|$)/i);
  if (pathMatch) return pathMatch[1];

  const queryMatch = value.match(/[?&#]id=(\d{1,20})(?:[&#]|$)/i);
  return queryMatch ? queryMatch[1] : null;
}

function parseQQSongMid(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  const detailMatch = value.match(/\/songDetail\/([A-Za-z0-9]{4,64})(?:[/?#]|$)/i);
  if (detailMatch) return detailMatch[1];

  const queryMatch = value.match(/[?&#]songmid=([A-Za-z0-9]{4,64})(?:[&#]|$)/i);
  return queryMatch ? queryMatch[1] : null;
}

function createVirtualPlaylistId(source, songId) {
  const sourceName = source === 'qq' ? 'qq' : 'netease';
  const digest = crypto
    .createHash('sha256')
    .update(`${sourceName}:song:${String(songId || '')}`)
    .digest('hex')
    .slice(0, 14);
  const body = (BigInt(`0x${digest}`) % 1000000000000000n)
    .toString()
    .padStart(15, '0');
  return `${sourceName === 'qq' ? '9' : '8'}${body}`;
}

module.exports = {
  parseNeteaseSongId,
  parseQQSongMid,
  createVirtualPlaylistId
};
