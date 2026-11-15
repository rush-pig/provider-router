const MAX_LOGS = 300;

const logs = [];
let nextLogId = 1;
const startedAt = Date.now();

const stats = {
  requests: 0,
  success: 0,
  errors: 0,
  totalDurationMs: 0,
  byProvider: {},
};

export function addLog(entry = {}) {
  const log = {
    id: nextLogId,
    at: new Date().toISOString(),
    method: entry.method ?? 'POST',
    path: entry.path ?? '',
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    conversion: entry.conversion ?? null,
    conversionWarnings: [],
    status: null,
    durationMs: null,
    error: null,
    completed: false,
  };
  nextLogId += 1;

  logs.push(log);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  return log.id;
}

export function completeLog(
  id,
  { status, error = null, durationMs = 0, warnings = [] },
) {
  const log = logs.find((item) => item.id === id);
  if (!log || log.completed) return;

  log.status = Number(status) || 0;
  log.error = error ? String(error) : null;
  log.conversionWarnings = normalizeWarnings(warnings);
  log.durationMs = Math.max(0, Math.round(durationMs));
  log.completed = true;

  stats.requests += 1;
  stats.totalDurationMs += log.durationMs;

  const successful = log.status >= 200 && log.status < 400;
  if (successful) stats.success += 1;
  else stats.errors += 1;

  const provider = log.provider || 'unknown';
  if (!stats.byProvider[provider]) {
    stats.byProvider[provider] = { requests: 0, success: 0, errors: 0 };
  }
  const providerStats = stats.byProvider[provider];
  providerStats.requests += 1;
  if (successful) providerStats.success += 1;
  else providerStats.errors += 1;
}

export function listLogs(limit = 100) {
  const count = Math.max(0, Math.min(Number(limit) || 100, MAX_LOGS));
  return logs.slice(-count).reverse();
}

export function clearLogs() {
  logs.length = 0;
}

export function getStats() {
  const now = Date.now();
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((now - startedAt) / 1000),
    requests: stats.requests,
    success: stats.success,
    errors: stats.errors,
    successRate: stats.requests > 0 ? stats.success / stats.requests : null,
    averageDurationMs:
      stats.requests > 0 ? Math.round(stats.totalDurationMs / stats.requests) : null,
    byProvider: structuredClone(stats.byProvider),
    pending: logs.filter((log) => !log.completed).length,
  };
}

export function getRecentLogs(limit = 6) {
  return listLogs(limit);
}

function normalizeWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings.slice(0, 20).map((warning) => {
    const entry = { code: String(warning?.code ?? 'conversion_warning') };
    if (warning?.field) entry.field = String(warning.field);
    if (Number.isFinite(warning?.count)) entry.count = warning.count;
    return entry;
  });
}
