// Live sheet access for the Netlify functions, via the Apps Script web app
// (see apps-script/Code.gs). Module-level cache persists per warm instance.

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();  // key -> {data, at}

async function appsScript(params) {
  const base = process.env.APPS_SCRIPT_URL;
  const key = process.env.SHEETS_SYNC_SECRET;
  if (!base || !key) {
    throw new Error('APPS_SCRIPT_URL / SHEETS_SYNC_SECRET env vars are not set in Netlify');
  }
  const qs = new URLSearchParams({ key, ...params });
  const r = await fetch(`${base}?${qs}`, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(`Apps Script: ${data.error}`);
  return data;
}

async function cached(key, ttl, fn, force) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl && !force) return hit.data;
  const data = await fn();
  cache.set(key, { data, at: Date.now() });
  return data;
}

const getTabValues = (title, force) =>
  cached(`tab:${title}`, CACHE_TTL, () => appsScript({ tab: title }), force);

const getTabList = (force) =>
  cached('tabs', 60 * 60 * 1000, () => appsScript({ list: '1' }), force);

module.exports = { getTabValues, getTabList };
