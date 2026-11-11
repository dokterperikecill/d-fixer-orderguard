const { sendAlert } = require('./alert');

const baseUrl = (process.env.ORDERGUARD_HEALTHCHECK_URL || process.env.STAGING_BASE_URL || '').replace(/\/+$/, '');
const timeoutMs = Number.parseInt(process.env.ORDERGUARD_HEALTHCHECK_TIMEOUT_MS || '', 10) || 10000;

async function probe(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal, redirect: 'manual' });
    const body = await response.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* response may not be JSON */ }
    return { ok: response.ok, status: response.status, body: json, durationMs: Number((performance.now() - startedAt).toFixed(1)) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!baseUrl) throw new Error('ORDERGUARD_HEALTHCHECK_URL (atau STAGING_BASE_URL) wajib diatur.');
  const result = await probe('/api/ready');
  const healthy = result.ok && result.body?.status === 'ready' && result.body?.database === 'ok';
  if (!healthy) {
    const message = `Readiness check gagal: HTTP ${result.status} dalam ${result.durationMs} ms`;
    console.error(JSON.stringify({ level: 'error', event: 'healthcheck_failed', status: result.status, body: result.body }));
    await sendAlert({ title: 'OrderGuard health check gagal', message, severity: 'critical', context: { status: result.status } });
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ level: 'info', event: 'healthcheck_ok', status: result.status, durationMs: result.durationMs, version: result.body?.version || null }));
}

main().catch(async (error) => {
  console.error(JSON.stringify({ level: 'error', event: 'healthcheck_error', message: error?.message || 'unknown error' }));
  await sendAlert({ title: 'OrderGuard health check error', message: error?.message || 'unknown error', severity: 'critical' });
  process.exitCode = 1;
});
