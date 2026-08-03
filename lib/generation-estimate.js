function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function estimateGenerationTiming(job = {}, activeWorkSeconds = 0, now = Date.now()) {
  const startedAt = Number(job.startedAt) || now;
  const endAt = Number(job.finishedAt) || now;
  const elapsedSeconds = Math.max(0, Math.floor((endAt - startedAt) / 1000));

  if (job.status === 'completed') return { elapsedSeconds, etaSeconds: 0 };
  if (job.status !== 'running') return { elapsedSeconds, etaSeconds: null };

  const total = finiteNonNegative(job.workTotalSeconds);
  const completed = finiteNonNegative(job.workCompletedSeconds);
  const processed = Math.min(total, completed + finiteNonNegative(activeWorkSeconds));
  const workStartedAt = Number(job.workStartedAt) || now;
  const workElapsedSeconds = Math.max(0, (now - workStartedAt) / 1000);
  if (total <= 0) return { elapsedSeconds, etaSeconds: 0 };
  if (workElapsedSeconds < 3 || processed < 1) return { elapsedSeconds, etaSeconds: null };

  const aggregateRate = processed / workElapsedSeconds;
  if (!Number.isFinite(aggregateRate) || aggregateRate <= 0) {
    return { elapsedSeconds, etaSeconds: null };
  }
  const remaining = Math.max(0, total - processed);
  const etaSeconds = Math.min(7 * 24 * 60 * 60, Math.ceil(remaining / aggregateRate));
  return { elapsedSeconds, etaSeconds };
}

module.exports = { estimateGenerationTiming };
