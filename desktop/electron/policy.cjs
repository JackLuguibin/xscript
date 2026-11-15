const path = require('node:path');
const fs = require('node:fs/promises');
const MAX_REQUEST = 4 * 1024 * 1024;
function rendererRequest(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_REQUEST) throw new Error('Invalid RPC size');
  const request = JSON.parse(raw);
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string') throw new Error('Invalid RPC');
  // Reconstruct the envelope; private host/native messages cannot pass the renderer boundary.
  return { id: request.id, method: request.method, params: request.params };
}
function trusted(url, devUrl) {
  try {
    const parsed = new URL(url);
    return devUrl ? parsed.origin === new URL(devUrl).origin : parsed.protocol === 'xsapp:' && parsed.host === 'app';
  } catch { return false; }
}
async function staticPath(root, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  if (rel.includes('\0') || rel.includes('\\')) return null;
  const base = await fs.realpath(root);
  try {
    const file = await fs.realpath(path.resolve(base, rel));
    const relative = path.relative(base, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) && (await fs.stat(file)).isFile() ? file : null;
  } catch { return null; }
}
module.exports = { rendererRequest, trusted, staticPath };
