const crypto = require('crypto');

// Vercel serverless version of the Lela Admin API.
// Admin credentials come from Vercel Environment Variables:
//   ADMIN_USERNAME
//   ADMIN_PASSWORD
// Optional:
//   ADMIN_SESSION_SECRET
//
// Note: live WebSocket users cannot be controlled directly from a Vercel
// serverless function. This keeps the admin login/session working and
// provides the same dashboard API shape so the UI no longer immediately
// reports "Session expired".

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const reports = globalThis.__lelaAdminReports || [];
const bans = globalThis.__lelaAdminBans || new Map();
globalThis.__lelaAdminReports = reports;
globalThis.__lelaAdminBans = bans;

function getSecret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'lela-admin-session-secret';
}

function base64url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function unbase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function sign(value) {
  return base64url(crypto.createHmac('sha256', getSecret()).update(value).digest());
}

function createSession() {
  const payload = base64url(JSON.stringify({
    exp: Date.now() + SESSION_TTL_MS
  }));
  return `${payload}.${sign(payload)}`;
}

function validSession(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  try {
    const data = JSON.parse(unbase64url(payload));
    return Number.isFinite(data.exp) && Date.now() < data.exp;
  } catch {
    return false;
  }
}

function cookies(req) {
  const header = req.headers.cookie || '';
  const result = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function setCookie(res, value) {
  res.setHeader('Set-Cookie', value);
}

function json(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk.toString('utf8');
      if (raw.length > 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req, res) {
  const token = cookies(req).admin_session;
  if (!validSession(token)) {
    json(res, 401, { error: 'Admin authentication required.' });
    return false;
  }
  return true;
}

function activeBans() {
  const now = Date.now();
  const result = [];
  for (const [userId, ban] of bans.entries()) {
    if (ban.expiresAt && now >= ban.expiresAt) {
      bans.delete(userId);
      continue;
    }
    result.push({ userId, ...ban });
  }
  return result;
}

function durationMs(value) {
  return ({
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    'permanent': null
  })[value] ?? 24 * 60 * 60 * 1000;
}

module.exports = async function handler(req, res) {
  const parts = Array.isArray(req.query.path)
    ? req.query.path
    : (typeof req.query.path === 'string' ? req.query.path.split('/').filter(Boolean) : []);
  const action = parts.join('/');

  if (action === 'login' && req.method === 'POST') {
    const usernameExpected = process.env.ADMIN_USERNAME || '';
    const passwordExpected = process.env.ADMIN_PASSWORD || '';

    if (!usernameExpected || !passwordExpected) {
      return json(res, 503, { error: 'Admin login is not configured on Vercel.' });
    }

    let data;
    try { data = await body(req); }
    catch (error) { return json(res, 400, { error: error.message }); }

    const username = String(data.username || '');
    const password = String(data.password || '');
    if (username !== usernameExpected || password !== passwordExpected) {
      return json(res, 401, { error: 'Invalid admin credentials.' });
    }

    const token = createSession();
    setCookie(res, `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax; Secure`);
    return json(res, 200, { ok: true });
  }

  if (action === 'logout' && req.method === 'POST') {
    setCookie(res, 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
    return json(res, 200, { ok: true });
  }

  if (!requireAdmin(req, res)) return;

  if (action === 'stats' && req.method === 'GET') {
    return json(res, 200, {
      online: 0,
      activeMatches: 0,
      waiting: 0,
      reportsTotal: reports.length,
      pendingReports: reports.filter(r => r.status === 'pending').length,
      activeBans: activeBans().length,
      serverTime: new Date().toISOString()
    });
  }

  if (action === 'users' && req.method === 'GET') {
    return json(res, 200, []);
  }

  if (action === 'reports' && req.method === 'GET') {
    return json(res, 200, reports);
  }

  if (action === 'bans' && req.method === 'GET') {
    return json(res, 200, activeBans());
  }

  const reportMatch = action.match(/^reports\/(\d+)\/(resolve|dismiss|ban)$/);
  if (reportMatch && req.method === 'POST') {
    const id = Number(reportMatch[1]);
    const operation = reportMatch[2];
    const report = reports.find(item => item.id === id);
    if (!report) return json(res, 404, { error: 'Report not found.' });

    if (operation === 'resolve') report.status = 'resolved';
    if (operation === 'dismiss') report.status = 'dismissed';
    if (operation === 'ban') {
      let data = {};
      try { data = await body(req); } catch {}
      const duration = String(data.duration || '24h');
      const ms = durationMs(duration);
      bans.set(report.reportedUserId, {
        reason: `Report #${report.id}: ${report.reason}`,
        createdAt: Date.now(),
        expiresAt: ms ? Date.now() + ms : null
      });
      report.status = 'resolved';
      report.action = `ban:${duration}`;
    }
    report.resolvedAt = Date.now();
    return json(res, 200, { ok: true, report });
  }

  const userMatch = action.match(/^users\/([^/]+)\/(ban|unban|disconnect)$/);
  if (userMatch && req.method === 'POST') {
    const userId = decodeURIComponent(userMatch[1]);
    const operation = userMatch[2];

    if (operation === 'disconnect') {
      return json(res, 200, { ok: true });
    }

    if (operation === 'unban') {
      bans.delete(userId);
      return json(res, 200, { ok: true });
    }

    let data = {};
    try { data = await body(req); } catch {}
    const duration = String(data.duration || '24h');
    const ms = durationMs(duration);
    bans.set(userId, {
      reason: String(data.reason || 'Administrator ban'),
      createdAt: Date.now(),
      expiresAt: ms ? Date.now() + ms : null
    });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Admin endpoint not found.' });
};
