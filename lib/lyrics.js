const fs = require('fs');

function cleanLyricText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLrc(raw) {
  const source = String(raw || '').replace(/^\uFEFF/, '');
  const offsetMatch = source.match(/^\s*\[offset:([+-]?\d+)\]/im);
  const offsetSeconds = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0;
  const cues = [];

  for (const line of source.split(/\r?\n/)) {
    const timestamps = Array.from(line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g));
    if (timestamps.length === 0) continue;
    const text = cleanLyricText(line.replace(/\[[^\]]+\]/g, ''));
    if (!text) continue;

    for (const match of timestamps) {
      const minutes = Number(match[1]) || 0;
      const seconds = Number(match[2]) || 0;
      const fractionRaw = match[3] || '0';
      const fraction = Number(fractionRaw) / (10 ** fractionRaw.length);
      cues.push({ start: Math.max(0, minutes * 60 + seconds + fraction + offsetSeconds), text });
    }
  }

  cues.sort((a, b) => a.start - b.start);
  return cues.filter((cue, index) => index === 0 || cue.start !== cues[index - 1].start || cue.text !== cues[index - 1].text);
}

function normalizeLyricsPayload(rawLyrics) {
  if (rawLyrics && typeof rawLyrics === 'object' && !Array.isArray(rawLyrics)) {
    return {
      original: String(rawLyrics.original || rawLyrics.lyric || rawLyrics.lrc || ''),
      translation: String(rawLyrics.translation || rawLyrics.translated || rawLyrics.trans || rawLyrics.tlyric || '')
    };
  }
  return { original: String(rawLyrics || ''), translation: '' };
}

function containsInstrumentalMarker(rawLyrics) {
  const payload = normalizeLyricsPayload(rawLyrics);
  return [payload.original, payload.translation].some((value) => (
    /纯音乐\s*[，,]\s*请欣赏/.test(cleanLyricText(value))
  ));
}

function parseBilingualLyrics(rawLyrics) {
  const payload = normalizeLyricsPayload(rawLyrics);
  const originals = parseLrc(payload.original);
  const translations = parseLrc(payload.translation);

  if (originals.length === 0) {
    return translations.map((cue) => ({ start: cue.start, primary: cue.text, original: '', translated: false }));
  }

  let translationIndex = 0;
  return originals.map((cue) => {
    while (
      translationIndex + 1 < translations.length &&
      Math.abs(translations[translationIndex + 1].start - cue.start) <= Math.abs(translations[translationIndex].start - cue.start)
    ) {
      translationIndex += 1;
    }
    const translatedCue = translations[translationIndex];
    const translatedText = translatedCue && Math.abs(translatedCue.start - cue.start) <= 0.65
      ? cleanLyricText(translatedCue.text)
      : '';
    const hasTranslation = Boolean(translatedText && translatedText !== cue.text);
    return {
      start: cue.start,
      primary: hasTranslation ? translatedText : cue.text,
      original: hasTranslation ? cue.text : '',
      translated: hasTranslation
    };
  });
}

function assTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const centis = Math.min(99, Math.floor((total - Math.floor(total)) * 100));
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function escapeAssText(value) {
  return cleanLyricText(value).replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝');
}

function createLyricsAss(filePath, rawLyrics, options = {}) {
  const width = Math.max(640, Math.round(Number(options.width) || 1920));
  const height = Math.max(360, Math.round(Number(options.height) || 1080));
  const duration = Math.max(1, Number(options.duration) || 240);
  const instrumental = containsInstrumentalMarker(rawLyrics);
  const parsedCues = instrumental ? [] : parseBilingualLyrics(rawLyrics);
  // 同一时间戳只保留最后一条状态，避免多个 ASS 事件叠在同一帧。
  const cues = parsedCues.filter((cue, index) => (
    index === parsedCues.length - 1 || cue.start !== parsedCues[index + 1].start
  ));
  const unit = Math.min(width / 1920, height / 1080);
  const centerX = Math.round(width * 0.665);
  const centerY = Math.round(height * 0.55);
  const farMainSize = Math.max(25, Math.round(30 * unit));
  const farOriginalSize = Math.max(15, Math.round(18 * unit));
  const nearMainSize = Math.max(32, Math.round(42 * unit));
  const nearOriginalSize = Math.max(19, Math.round(24 * unit));
  const currentMainSize = Math.max(50, Math.round(72 * unit));
  const currentOriginalSize = Math.max(24, Math.round(36 * unit));
  const fontName = String(options.fontName || 'Noto Sans SC').replace(/,/g, ' ');
  const hardCut = options.hardCut === true;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Lyrics,${fontName},${nearMainSize},&H00FFFFFF,&H00FFFFFF,&H78000000,&H00000000,0,0,0,0,100,100,0,0,1,0.75,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lyricRole = (role) => {
    if (role === 'current') {
      return {
        mainSize: currentMainSize,
        originalSize: currentOriginalSize,
        mainAlpha: '&H00&',
        originalAlpha: '&H38&'
      };
    }
    if (role === 'far') {
      return {
        mainSize: farMainSize,
        originalSize: farOriginalSize,
        mainAlpha: '&HA8&',
        originalAlpha: '&HC0&'
      };
    }
    return {
      mainSize: nearMainSize,
      originalSize: nearOriginalSize,
      mainAlpha: '&H68&',
      originalAlpha: '&H8C&'
    };
  };

  const transformTag = (startMs, endMs, targetSize, targetAlpha) => (
    startMs == null || endMs == null
      ? ''
      : `\\t(${startMs},${endMs},0.85,\\fs${targetSize}\\alpha${targetAlpha})`
  );

  const slotOffsets = [-205, -112, 0, 112, 205].map((value) => Math.round(value * unit));
  const slotCenterY = (slotIndex) => {
    if (slotIndex < 0) {
      const step = slotOffsets[1] - slotOffsets[0];
      return centerY + slotOffsets[0] + slotIndex * step;
    }
    if (slotIndex >= slotOffsets.length) {
      const last = slotOffsets.length - 1;
      const step = slotOffsets[last] - slotOffsets[last - 1];
      return centerY + slotOffsets[last] + (slotIndex - last) * step;
    }
    return centerY + slotOffsets[slotIndex];
  };

  const roleForSlot = (slotIndex) => {
    const distance = Math.abs(slotIndex - 2);
    return distance === 0 ? 'current' : (distance === 1 ? 'near' : 'far');
  };

  const lineY = (slotIndex, role, hasOriginal, lineType) => {
    const center = slotCenterY(slotIndex);
    if (!hasOriginal) return center;
    const style = lyricRole(role);
    if (lineType === 'original') {
      return center + Math.round(style.mainSize * 0.52);
    }
    return center - Math.round(style.originalSize * 0.58 + 4 * unit);
  };

  const positionTag = (startY, endY, animationWindow) => {
    if (!animationWindow) return `\\pos(${centerX},${startY})`;
    return `\\move(${centerX},${startY},${centerX},${endY},${animationWindow.startMs},${animationWindow.endMs})`;
  };

  const renderLine = ({ cue, lineType, startRole, endRole, startSlot, endSlot, animationWindow }) => {
    const from = lyricRole(startRole);
    const to = lyricRole(endRole);
    const isOriginal = lineType === 'original';
    const startSize = isOriginal ? from.originalSize : from.mainSize;
    const endSize = isOriginal ? to.originalSize : to.mainSize;
    const startAlpha = isOriginal ? from.originalAlpha : from.mainAlpha;
    const endAlpha = isOriginal ? to.originalAlpha : to.mainAlpha;
    const startY = lineY(startSlot, startRole, Boolean(cue.original), lineType);
    const endY = lineY(endSlot, endRole, Boolean(cue.original), lineType);
    const transform = transformTag(animationWindow?.startMs, animationWindow?.endMs, endSize, endAlpha);
    const position = positionTag(startY, endY, animationWindow);
    const text = isOriginal ? cue.original : cue.primary;
    return `{\\an5${position}\\rLyrics\\fs${startSize}\\b650\\alpha${startAlpha}${transform}}${escapeAssText(text)}`;
  };

  const lines = [];
  for (let index = 0; index < cues.length; index++) {
    const start = cues[index].start;
    if (start >= duration) break;
    const nextStart = cues[index + 1]?.start;
    const end = Math.min(duration, Number.isFinite(nextStart) && nextStart > start ? nextStart : duration);
    const cueDurationMs = Math.max(1, Math.round((end - start) * 1000));
    const hasNextCue = Number.isFinite(nextStart) && nextStart > start && nextStart <= duration;
    const shouldSlide = hasNextCue && cueDurationMs >= 900;
    const slideDurationMs = shouldSlide ? Math.min(560, Math.max(360, Math.floor(cueDurationMs * 0.30))) : 0;
    const slideStartMs = Math.max(0, cueDurationMs - slideDurationMs);
    const animationWindow = !hardCut && shouldSlide
      ? { startMs: slideStartMs, endMs: cueDurationMs }
      : null;
    // 每一行使用独立的绝对坐标，Y 轴终点始终小于起点；字号变化不再触发整块文本重排，
    // 因而不会出现上滑过头后向下回弹。极速模式和过短歌词段仍直接定位。
    for (let slotIndex = 0; slotIndex < 5; slotIndex++) {
      const cue = cues[index + slotIndex - 2];
      if (!cue) continue;
      const startRole = roleForSlot(slotIndex);
      const endSlot = slotIndex - 1;
      const endRole = roleForSlot(endSlot);
      const main = renderLine({
        cue,
        lineType: 'main',
        startRole,
        endRole,
        startSlot: slotIndex,
        endSlot,
        animationWindow
      });
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Lyrics,Main,0,0,0,,${main}`);
      if (cue.original) {
        const original = renderLine({
          cue,
          lineType: 'original',
          startRole,
          endRole,
          startSlot: slotIndex,
          endSlot,
          animationWindow
        });
        lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Lyrics,Original,0,0,0,,${original}`);
      }
    }
  }

  fs.writeFileSync(filePath, `${header}${lines.join('\n')}\n`, 'utf8');
  return {
    filePath,
    cueCount: cues.length,
    translatedCueCount: cues.filter((cue) => cue.translated).length,
    instrumental
  };
}

module.exports = {
  cleanLyricText,
  parseLrc,
  normalizeLyricsPayload,
  containsInstrumentalMarker,
  parseBilingualLyrics,
  createLyricsAss,
  assTime
};
