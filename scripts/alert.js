const DEFAULT_TIMEOUT_MS = 5000;

function normalizePayload({ title, message = '', severity = 'error', context = {} }) {
  const safeTitle = String(title || 'OrderGuard alert').slice(0, 200);
  const safeMessage = String(message || '').slice(0, 2000);
  const text = `[${String(severity).toUpperCase()}] ${safeTitle}${safeMessage ? ` — ${safeMessage}` : ''}`;
  const format = process.env.ORDERGUARD_ALERT_WEBHOOK_FORMAT || 'slack';
  if (format === 'generic') {
    return {
      text,
      title: safeTitle,
      message: safeMessage,
      severity,
      source: 'orderguard',
      hostname: process.env.HOSTNAME || '',
      timestamp: new Date().toISOString(),
      context,
    };
  }
  return { text };
}

async function sendAlert(options = {}) {
  const url = process.env.ORDERGUARD_ALERT_WEBHOOK_URL || '';
  if (!url) return { sent: false, reason: 'not_configured' };
  const timeoutMs = Number.parseInt(process.env.ORDERGUARD_ALERT_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalizePayload(options)),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(JSON.stringify({ level: 'error', event: 'alert_failed', status: response.status }));
      return { sent: false, reason: `http_${response.status}` };
    }
    return { sent: true, status: response.status };
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'alert_failed', message: error?.message || 'unknown error' }));
    return { sent: false, reason: error?.message || 'request_failed' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendAlert, normalizePayload };

if (require.main === module) {
  const args = process.argv.slice(2);
  const readFlag = (name, fallback = '') => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  sendAlert({
    title: readFlag('--title', 'OrderGuard manual alert'),
    message: readFlag('--message', ''),
    severity: readFlag('--severity', 'info'),
  }).then((result) => {
    console.log(JSON.stringify(result));
    if (!result.sent && result.reason !== 'not_configured') process.exitCode = 1;
  });
}
