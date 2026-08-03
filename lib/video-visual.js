const fs = require('fs');
const path = require('path');

const FALLBACK_FONT_PATHS = [
  process.env.VIDEO_FONT_FILE,
  'C:\\Windows\\Fonts\\msyhbd.ttc',
  'C:\\Windows\\Fonts\\Dengb.ttf',
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\NotoSansSC-VF.ttf',
  'C:\\Windows\\Fonts\\msyh.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc',
  '/windows/C/Windows/Fonts/NotoSansSC-VF.ttf',
  '/windows/C/Windows/Fonts/msyh.ttc',
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
].filter(Boolean);

function firstText(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const joined = value.map((item) => String(item || '').trim()).filter(Boolean).join(' / ');
      if (joined) return joined;
      continue;
    }
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function displayUnits(value) {
  return Array.from(String(value || '')).reduce((total, char) => total + (/^[\x00-\xff]$/.test(char) ? 0.56 : 1), 0);
}

function truncateToUnits(value, maxUnits, suffix = '...') {
  const text = String(value || '');
  const limit = Number(maxUnits);
  if (!Number.isFinite(limit) || limit <= 0 || displayUnits(text) <= limit) return text;
  const suffixUnits = displayUnits(suffix);
  let used = 0;
  let result = '';
  for (const char of Array.from(text)) {
    const units = displayUnits(char);
    if (used + units + suffixUnits > limit) break;
    result += char;
    used += units;
  }
  return `${result}${suffix}`;
}

function compactText(value, maxLength, maxUnits = Infinity) {
  // 文字宽度由视频滤镜自动判断；超出显示区时循环滚动，不再截断成省略号。
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function normalizeTrackMeta(track = {}, playlistName = '', limits = {}, options = {}) {
  const meta = {
    title: compactText(firstText(track.name, track.title, '未知歌曲'), 34, limits.title),
    subtitle: compactText(firstText(track.subtitle, track.subTitle, track.alias, track.alia), 46, limits.subtitle),
    album: compactText(firstText(track.album, track.albumName, playlistName, '未知专辑'), 42, limits.album),
    artist: compactText(firstText(track.artist, track.artists, '未知歌手'), 42)
  };
  if (!options.truncate) return meta;
  return {
    title: truncateToUnits(meta.title, limits.title),
    subtitle: truncateToUnits(meta.subtitle, limits.subtitle),
    album: truncateToUnits(meta.album, limits.album),
    artist: truncateToUnits(meta.artist, limits.artist)
  };
}

function resolveFontFile() {
  return FALLBACK_FONT_PATHS.find((filePath) => {
    try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
  }) || '';
}

function escapeFilterValue(value) {
  return String(value || '').replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function createTextAssets(basePath, track, playlistName = '', options = {}) {
  const width = Math.max(640, Math.round(Number(options.width) || 1920));
  const height = Math.max(360, Math.round(Number(options.height) || 1080));
  const unit = Math.min(width / 1920, height / 1080);
  const rightWidth = width * 0.49;
  const coverWidth = Math.min(width * 0.245, height * 0.43);
  const limits = {
    title: Math.floor(rightWidth / Math.max(28, 62 * unit)),
    subtitle: Math.floor(rightWidth / Math.max(18, 27 * unit)),
    album: Math.floor(coverWidth / Math.max(15, 27 * unit)),
    artist: Math.floor(coverWidth / Math.max(14, 23 * unit))
  };
  const meta = normalizeTrackMeta(track, playlistName, limits, { truncate: options.truncate === true });
  const files = {
    title: `${basePath}_title.txt`,
    subtitle: `${basePath}_subtitle.txt`,
    album: `${basePath}_album.txt`,
    artist: `${basePath}_artist.txt`,
    collectionTitle: `${basePath}_collection_title.txt`,
    collectionAuthor: `${basePath}_collection_author.txt`,
    trackCounter: `${basePath}_track_counter.txt`
  };
  fs.writeFileSync(files.title, meta.title, 'utf8');
  fs.writeFileSync(files.subtitle, meta.subtitle, 'utf8');
  fs.writeFileSync(files.album, meta.album, 'utf8');
  fs.writeFileSync(files.artist, meta.artist, 'utf8');
  const collectionName = compactText(options.collectionName || playlistName);
  const collectionCreator = compactText(options.collectionCreator);
  const collectionType = options.collectionType === 'album' ? '专辑' : '歌单';
  const showCollection = options.showCollection === true && Boolean(collectionName);
  const currentIndex = Math.max(1, Math.round(Number(options.currentIndex) || 1));
  const totalTracks = Math.max(currentIndex, Math.round(Number(options.totalTracks) || currentIndex));
  fs.writeFileSync(files.collectionTitle, showCollection ? `${collectionType}：${collectionName}` : '', 'utf8');
  fs.writeFileSync(files.collectionAuthor, showCollection && collectionCreator ? `作者：${collectionCreator}` : '', 'utf8');
  fs.writeFileSync(files.trackCounter, `${currentIndex} / ${totalTracks}`, 'utf8');
  return { meta, files, showCollection };
}

function removeTextAssets(assets) {
  if (!assets?.files) return;
  for (const filePath of Object.values(assets.files)) {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function buildVisualFilter({
  width,
  height,
  fps,
  duration,
  textFiles,
  lyricsFile,
  fontFile = resolveFontFile(),
  transitionSeconds = process.env.VIDEO_TRANSITION_SECONDS,
  staticText = false,
  disableFade = false,
  durationOnly = false,
  singleFrame = false,
  hasLyrics,
  showCollection = false
}) {
  const w = Math.max(640, Math.round(Number(width) || 1920));
  const h = Math.max(360, Math.round(Number(height) || 1080));
  const frameRate = Math.max(1, Math.round(Number(fps) || 15));
  const safeDuration = Math.max(1, Number(duration) || 240);
  const parsedTransition = Number(transitionSeconds);
  const transition = Number.isFinite(parsedTransition)
    ? Math.max(0.2, Math.min(2, parsedTransition))
    : 0.8;
  const fadeOutStart = Math.max(0, safeDuration - transition);
  const unit = Math.min(w / 1920, h / 1080);

  const coverSize = Math.round(Math.min(w * 0.245, h * 0.43));
  const coverX = Math.round(w * 0.105);
  const coverY = Math.round((h - coverSize) * 0.48);
  const coverRadius = Math.max(18, Math.round(30 * unit));
  const albumY = coverY + coverSize + Math.round(34 * unit);

  const rightX = Math.round(w * 0.42);
  const rightWidth = Math.round(w * 0.49);
  const lyricsAvailable = hasLyrics === undefined ? Boolean(lyricsFile) : hasLyrics === true;
  const titleY = Math.round(h * (lyricsAvailable ? 0.14 : 0.35));
  const subtitleY = titleY + Math.round(82 * unit);
  const barX = rightX + Math.round(30 * unit);
  const barWidth = rightWidth - Math.round(60 * unit);
  const barY = Math.round(h * (lyricsAvailable ? 0.84 : 0.62));
  const barHeight = Math.max(10, Math.round(12 * unit));
  const barRadius = barHeight / 2;
  const timeY = barY + Math.round(27 * unit);

  const titleSize = Math.max(30, Math.round(62 * unit));
  const subtitleSize = Math.max(18, Math.round(27 * unit));
  const infoSize = Math.max(18, Math.round(27 * unit));
  const timeSize = Math.max(16, Math.round(22 * unit));
  const collectionTitleSize = Math.max(11, Math.round(15 * unit));
  const collectionAuthorSize = Math.max(10, Math.round(13 * unit));
  const counterSize = Math.max(9, Math.round(11 * unit));
  const edgeMargin = Math.max(14, Math.round(24 * unit));
  const backgroundBlur = Math.max(28, Math.round(58 * unit));
  const font = escapeFilterValue(fontFile);
  const lyricPath = escapeFilterValue(lyricsFile);
  // Windows 系统字体目录包含大量旧式 .fon 文件，交给 libass 全量扫描既慢又会刷出大量警告。
  // 系统已注册这些字体，只有容器中的独立字体目录才需要显式传给 subtitles。
  const fontsDir = fontFile && !/windows[\\/]fonts/i.test(fontFile)
    ? escapeFilterValue(path.dirname(fontFile))
    : '';
  const fontOption = font ? `fontfile='${font}':` : '';

  const scrollGap = Math.max(48, Math.round(88 * unit));
  const scrollSpeed = Math.max(48, Math.round(78 * unit));
  const scrollingTextLayer = (label, filePath, size, color, areaWidth, speed = scrollSpeed) => {
    const layerHeight = Math.max(size + 12, Math.round(size * 1.55));
    const textY = Math.max(2, Math.round((layerHeight - size) * 0.32));
    const cycle = `mod(max(t-0.8,0)*${speed},text_w+${scrollGap})`;
    const common = `${fontOption}textfile='${escapeFilterValue(filePath)}':expansion=none:fontcolor=${color}:fontsize=${size}:` +
      `y=${textY}:borderw=1:bordercolor=black@0.20:shadowcolor=black@0.20:shadowx=1:shadowy=1`;
    if (staticText) {
      return {
        height: layerHeight,
        filters: [
          `color=c=black@0:s=${areaWidth}x${layerHeight}:r=${frameRate},format=rgba,trim=end_frame=1,setpts=PTS-STARTPTS,` +
            `drawtext=${common}:x=(${areaWidth}-text_w)/2[${label}static]`,
          `[${label}static]loop=loop=-1:size=1:start=0,setpts=N/(${frameRate}*TB)[${label}layer]`
        ]
      };
    }
    return {
      height: layerHeight,
      filters: [
        `color=c=black@0:s=${areaWidth}x${layerHeight}:r=${frameRate}:d=${safeDuration.toFixed(3)},format=rgba[${label}canvas]`,
        `[${label}canvas]drawtext=${common}:x='if(lte(text_w,${areaWidth}),(${areaWidth}-text_w)/2,-${cycle})'[${label}first]`,
        `[${label}first]drawtext=${common}:x='if(lte(text_w,${areaWidth}),${areaWidth * 2},text_w+${scrollGap}-${cycle})'[${label}layer]`
      ]
    };
  };

  const albumLayer = scrollingTextLayer('albumscroll', textFiles.album, infoSize, 'white@0.92', coverSize, Math.max(38, Math.round(62 * unit)));
  const artistLayer = scrollingTextLayer('artistscroll', textFiles.artist, Math.max(16, Math.round(infoSize * 0.84)), 'white@0.76', coverSize, Math.max(34, Math.round(54 * unit)));
  const titleLayer = scrollingTextLayer('titlescroll', textFiles.title, titleSize, 'white', rightWidth);
  const subtitleLayer = scrollingTextLayer('subtitlescroll', textFiles.subtitle, subtitleSize, 'white@0.88', rightWidth, Math.max(40, Math.round(66 * unit)));

  const roundedCoverAlpha =
    `if(lte(pow(max(abs(X-W/2)-(W/2-${coverRadius}),0),2)+` +
    `pow(max(abs(Y-H/2)-(H/2-${coverRadius}),0),2),${coverRadius * coverRadius}),255,0)`;
  const roundedBarAlpha =
    `if(lte(pow(max(abs(X-W/2)-(W/2-${barRadius}),0),2)+pow(Y-H/2,2),${barRadius * barRadius}),52,0)`;
  const progressPixels = `W*min(1,N/(${frameRate}*${safeDuration.toFixed(3)}))`;
  const progressAlpha =
    `if(gte(${progressPixels},${barHeight})*lte(X,${progressPixels})*gt(` +
    `between(X,${barRadius},${progressPixels}-${barRadius})+` +
    `lte(pow(X-${barRadius},2)+pow(Y-${barRadius},2),${barRadius * barRadius})+` +
    `lte(pow(X-(${progressPixels}-${barRadius}),2)+pow(Y-${barRadius},2),${barRadius * barRadius}),0),235,0)`;
  const currentTimeText =
    `%{eif\\:floor(t/60)\\:d\\:2}\\:%{eif\\:mod(floor(t)\\,60)\\:d\\:2}`;

  const filters = [
    `[0:v]split=2[bgsrc][coversrc]`,
    `[bgsrc]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${w}:${h}:force_original_aspect_ratio=increase,` +
      `crop=${w}:${h},gblur=sigma=${backgroundBlur},eq=saturation=1.30:contrast=1.05:brightness=-0.08,` +
      `vignette=PI/5,format=yuv420p,loop=loop=-1:size=1:start=0,setpts=N/(${frameRate}*TB)[background]`,
    `[coversrc]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${coverSize}:${coverSize}:force_original_aspect_ratio=increase,` +
      `crop=${coverSize}:${coverSize},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${roundedCoverAlpha}',` +
      `loop=loop=-1:size=1:start=0,setpts=N/(${frameRate}*TB)[cover]`,
    `[background]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.04:t=fill[base]`,
    `[base][cover]overlay=x=${coverX}:y=${coverY}:format=auto[coverlaid]`,
    ...albumLayer.filters,
    ...artistLayer.filters,
    ...titleLayer.filters,
    ...subtitleLayer.filters,
    `[coverlaid][albumscrolllayer]overlay=x=${coverX}:y=${albumY}:format=auto[album]`,
    `[album][artistscrolllayer]overlay=x=${coverX}:y=${albumY + albumLayer.height + Math.round(2 * unit)}:format=auto[artist]`,
    `[artist][titlescrolllayer]overlay=x=${rightX}:y=${titleY}:format=auto[title]`,
    `[title][subtitlescrolllayer]overlay=x=${rightX}:y=${subtitleY}:format=auto[subtitle]`
  ];

  let contextLabel = 'subtitle';
  if (lyricsAvailable) {
    filters.push(
      `[subtitle]subtitles=filename='${lyricPath}'${fontsDir ? `:fontsdir='${fontsDir}'` : ''}[lyrics]`
    );
    contextLabel = 'lyrics';
  }
  if (showCollection) {
    const titlePath = escapeFilterValue(textFiles.collectionTitle);
    const authorPath = escapeFilterValue(textFiles.collectionAuthor);
    const authorY = h - edgeMargin - collectionAuthorSize;
    const collectionY = authorY - collectionTitleSize - Math.max(3, Math.round(4 * unit));
    filters.push(
      `[${contextLabel}]drawtext=${fontOption}textfile='${titlePath}':expansion=none:fontcolor=white@0.82:` +
        `fontsize=${collectionTitleSize}:x=${edgeMargin}:y=${collectionY}:borderw=1:bordercolor=black@0.16[collectiontitle]`,
      `[collectiontitle]drawtext=${fontOption}textfile='${authorPath}':expansion=none:fontcolor=white@0.68:` +
        `fontsize=${collectionAuthorSize}:x=${edgeMargin}:y=${authorY}:borderw=1:bordercolor=black@0.14[collectionauthor]`
    );
    contextLabel = 'collectionauthor';
  }

  filters.push(
    `[${contextLabel}]drawtext=${fontOption}textfile='${escapeFilterValue(textFiles.trackCounter)}':expansion=none:` +
      `fontcolor=white@0.58:fontsize=${counterSize}:x=w-text_w-${edgeMargin}:y=h-text_h-${edgeMargin}:` +
      `borderw=1:bordercolor=black@0.12[trackcounter]`
  );

  if (durationOnly) {
    filters.push(
      `[trackcounter]drawtext=${fontOption}text='${formatClock(safeDuration).replace(':', '\\:')}':` +
        `fontcolor=white@0.76:fontsize=${timeSize}:x=${barX}+(${barWidth}-text_w)/2:y=${barY}:` +
        `borderw=1:bordercolor=black@0.18:shadowcolor=black@0.16:shadowx=1:shadowy=1[durationonly]`,
      singleFrame
        ? `[durationonly]trim=end_frame=1,setpts=PTS-STARTPTS,loop=loop=-1:size=1:start=0,` +
          `setpts=N/(${frameRate}*TB),format=yuv420p[vout]`
        : `[durationonly]format=yuv420p[vout]`
    );
    return filters.join(';');
  }

  filters.push(
    `color=c=white:s=${barWidth}x${barHeight}:r=${frameRate}:d=${safeDuration.toFixed(3)},` +
      `format=rgba,geq=r='255':g='255':b='255':a='${roundedBarAlpha}'[bartrack]`,
    `[trackcounter][bartrack]overlay=x=${barX}:y=${barY}:format=auto[barbase]`,
    `color=c=white:s=${barWidth}x${barHeight}:r=${frameRate}:d=${safeDuration.toFixed(3)},` +
      `format=rgba,geq=r='255':g='255':b='255':a='${progressAlpha}'[progress]`,
    `[barbase][progress]overlay=x=${barX}:y=${barY}:format=auto[progresslaid]`,
    `[progresslaid]drawtext=${fontOption}text='${currentTimeText}':fontcolor=white@0.70:fontsize=${timeSize}:` +
      `x=${barX}:y=${timeY}:borderw=1:bordercolor=black@0.18:shadowcolor=black@0.16:shadowx=1:shadowy=1[currenttime]`,
    `[currenttime]drawtext=${fontOption}text='${formatClock(safeDuration).replace(':', '\\:')}':fontcolor=white@0.70:fontsize=${timeSize}:` +
      `x=${barX + barWidth}-text_w:y=${timeY}:borderw=1:bordercolor=black@0.18:shadowcolor=black@0.16:shadowx=1:shadowy=1[times]`,
    disableFade
      ? `[times]format=yuv420p[vout]`
      : `[times]fade=t=in:st=0:d=${transition.toFixed(3)},` +
        `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${transition.toFixed(3)},format=yuv420p[vout]`
  );

  return filters.join(';');
}

module.exports = {
  normalizeTrackMeta,
  truncateToUnits,
  resolveFontFile,
  createTextAssets,
  removeTextAssets,
  formatClock,
  buildVisualFilter
};
