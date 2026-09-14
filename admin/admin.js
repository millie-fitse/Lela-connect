(() => {
  const loginView = document.getElementById('loginView');
  const appView = document.getElementById('appView');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const logoutButton = document.getElementById('logoutButton');
  const pageTitle = document.getElementById('pageTitle');
  const updatedText = document.getElementById('updatedText');
  let timer = null;

  function showLogin(message = '') {
    loginView.style.display = 'grid';
    appView.style.display = 'none';
    loginError.textContent = message;
    if (timer) clearInterval(timer);
  }

  function showApp() {
    loginView.style.display = 'none';
    appView.style.display = 'grid';
    refreshAll();
    timer = setInterval(refreshAll, 2000);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.textContent = '';
    try {
      await api('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value,
          password: document.getElementById('password').value
        })
      });
      showApp();
    } catch (error) {
      loginError.textContent = error.message;
    }
  });

  logoutButton.addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
    showLogin();
  });

  document.querySelectorAll('.nav button').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      const section = button.dataset.section;
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.getElementById(`section-${section}`).classList.add('active');
      pageTitle.textContent = section[0].toUpperCase() + section.slice(1);
    });
  });

  async function refreshAll() {
    try {
      const [stats, users, reports, bans] = await Promise.all([
        api('/api/admin/stats'),
        api('/api/admin/users'),
        api('/api/admin/reports'),
        api('/api/admin/bans')
      ]);

      document.getElementById('mOnline').textContent = stats.online;
      document.getElementById('mMatches').textContent = stats.activeMatches;
      document.getElementById('mWaiting').textContent = stats.waiting;
      document.getElementById('mReports').textContent = stats.pendingReports;
      document.getElementById('updatedText').textContent = `Updated ${new Date(stats.serverTime).toLocaleTimeString()}`;

      renderUsers(users);
      renderReports(reports);
      renderBans(bans);
    } catch (error) {
      if (/401|authentication/i.test(error.message)) showLogin('Session expired. Sign in again.');
    }
  }

  function safe(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  function renderUsers(users) {
    document.getElementById('usersPill').textContent = users.length;
    const body = document.getElementById('usersBody');
    if (!users.length) { body.innerHTML = '<tr><td colspan="5" class="empty">No connected users.</td></tr>'; return; }
    body.innerHTML = users.map(user => {
      const status = user.banned ? 'banned' : user.status;
      const dot = user.banned ? 'banned' : user.status === 'waiting' ? 'waiting' : 'online';
      return `<tr>
        <td>${safe(user.userId)}</td>
        <td>#${safe(user.clientId)}</td>
        <td><span class="status-dot ${dot}"></span>${safe(status)}</td>
        <td>${safe(new Date(user.connectedAt).toLocaleString())}</td>
        <td class="actions">
          <button class="action" data-user-action="disconnect" data-user="${encodeURIComponent(user.userId)}">Disconnect</button>
          <button class="action danger" data-user-action="ban" data-user="${encodeURIComponent(user.userId)}">Ban 24h</button>
          ${user.banned ? '<button class="action good" data-user-action="unban" data-user="'+encodeURIComponent(user.userId)+'">Unban</button>' : ''}
        </td>
      </tr>`;
    }).join('');
  }

  function renderReports(reports) {
    document.getElementById('reportsPill').textContent = reports.filter(r => r.status === 'pending').length;
    const body = document.getElementById('reportsBody');
    if (!reports.length) { body.innerHTML = '<tr><td colspan="7" class="empty">No reports yet.</td></tr>'; return; }
    body.innerHTML = reports.map(report => `<tr>
      <td>#${safe(report.id)}</td><td>${safe(report.reason)}</td><td>${safe(report.reporterUserId)}</td><td>${safe(report.reportedUserId)}</td>
      <td>${safe(report.status)}</td><td>${safe(new Date(report.createdAt).toLocaleString())}</td>
      <td class="actions">
        ${report.status === 'pending' ? `<button class="action danger" data-report-action="ban" data-report="${report.id}">Ban 24h</button><button class="action good" data-report-action="resolve" data-report="${report.id}">Resolve</button><button class="action" data-report-action="dismiss" data-report="${report.id}">Dismiss</button>` : ''}
      </td>
    </tr>`).join('');
  }

  function renderBans(bans) {
    document.getElementById('bansPill').textContent = bans.length;
    const body = document.getElementById('bansBody');
    if (!bans.length) { body.innerHTML = '<tr><td colspan="5" class="empty">No active bans.</td></tr>'; return; }
    body.innerHTML = bans.map(ban => `<tr>
      <td>${safe(ban.userId)}</td><td>${safe(ban.reason)}</td><td>${safe(new Date(ban.createdAt).toLocaleString())}</td>
      <td>${ban.expiresAt ? safe(new Date(ban.expiresAt).toLocaleString()) : 'Permanent'}</td>
      <td><button class="action good" data-ban-action="unban" data-user="${encodeURIComponent(ban.userId)}">Unban</button></td>
    </tr>`).join('');
  }

  document.addEventListener('click', async (event) => {
    const userButton = event.target.closest('[data-user-action]');
    if (userButton) {
      const action = userButton.dataset.userAction;
      const user = decodeURIComponent(userButton.dataset.user);
      if (action === 'ban' && !confirm(`Ban ${user} for 24 hours?`)) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(user)}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: '24h', reason: 'Administrator action' })
        });
        await refreshAll();
      } catch (e) { alert(e.message); }
      return;
    }

    const reportButton = event.target.closest('[data-report-action]');
    if (reportButton) {
      const action = reportButton.dataset.reportAction;
      const id = reportButton.dataset.report;
      if (action === 'ban' && !confirm(`Ban the reported user for 24 hours?`)) return;
      try {
        await api(`/api/admin/reports/${id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: '24h' })
        });
        await refreshAll();
      } catch (e) { alert(e.message); }
      return;
    }

    const banButton = event.target.closest('[data-ban-action]');
    if (banButton) {
      const user = decodeURIComponent(banButton.dataset.user);
      try {
        await api(`/api/admin/users/${encodeURIComponent(user)}/unban`, { method: 'POST' });
        await refreshAll();
      } catch (e) { alert(e.message); }
    }
  });

  // No admin session endpoint is exposed; a successful stats request means the session exists.
  api('/api/admin/stats').then(showApp).catch(() => showLogin());
})();
