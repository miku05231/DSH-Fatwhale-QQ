import { parentPort, workerData } from 'node:worker_threads';
import { probeNapcatOnebot } from './napcat-health.js';

if (parentPort) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, workerData.deadline - Date.now()));
  try {
    const health = await probeNapcatOnebot({ onebotUrl: workerData.url, accessToken: workerData.accessToken }, controller.signal, workerData.deadline);
    parentPort.postMessage({ ok: true, health });
  } catch {
    parentPort.postMessage({ ok: false });
  } finally { clearTimeout(timer); }
}
