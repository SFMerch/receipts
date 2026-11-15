/* SFM Receipts - phone app */
(function () {
  'use strict';

  const API = window.SFM_API_URL || '';
  const KEY = 'sfm_session';
  const $ = id => document.getElementById(id);

  /* ---------- Session stored on the phone ---------- */
  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && s.token && s.expires > Date.now()) return s;
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveSession(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }
  function clearSession() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }

  /* ---------- Back end calls ---------- */
  async function api(action, data) {
    if (!API) throw new Error('NOT_CONFIGURED');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const resp = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action }, data || {})),
        signal: ctrl.signal
      });
      return await resp.json();
    } finally {
      clearTimeout(t);
    }
  }

  /* ---------- Screens ---------- */
  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    $(id).classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  function showLogin(msg) {
    $('loginPin').value = '';
    setMsg(msg || '');
    show('screenLogin');
  }

  function setMsg(text, ok) {
    const m = $('loginMsg');
    m.textContent = text;
    m.className = 'msg' + (ok ? ' ok' : '');
  }

  function showHome(s) {
    $('helloName').textContent = s.user.name;
    const car = (s.cars || []).find(c => c.id === s.myCarId);
    $('myCar').textContent = car ? 'Your car: ' + car.label : '';
    const until = new Date(s.expires);
    $('sessionInfo').textContent = 'Signed in until ' + until.toLocaleDateString();
    showInstallTip();
    show('screenHome');
  }

  function showInstallTip() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    const tip = $('installTip');
    if (standalone) { tip.classList.add('hidden'); return; }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    tip.innerHTML = ios
      ? '<b>Tip:</b> tap the Share button, then <b>Add to Home Screen</b>, so this opens like an app, even with no signal.'
      : '<b>Tip:</b> tap the browser menu (&#8942;), then <b>Add to Home screen</b> or <b>Install app</b>, so this opens like an app, even with no signal.';
    tip.classList.remove('hidden');
  }

  /* ---------- Login ---------- */
  async function doLogin() {
    const name = $('loginName').value.trim();
    const pin = $('loginPin').value.trim();
    if (!name || !/^\d{6}$/.test(pin)) { setMsg('Enter your first name and 6-digit PIN.'); return; }
    if (!navigator.onLine) { setMsg('No service.  You need a signal to sign in the first time.'); return; }

    const btn = $('btnLogin');
    btn.disabled = true; btn.textContent = 'Signing in…'; setMsg('');
    try {
      const r = await api('login', { name: name, pin: pin });
      if (!r.ok) { setMsg(r.error || 'Sign-in failed.'); return; }
      const s = { token: r.token, expires: r.expires, user: r.user, cars: r.cars,
                  myCarId: r.myCarId, categories: r.categories };
      saveSession(s);
      try { localStorage.setItem('sfm_last_name', s.user.name); } catch (e) { /* ignore */ }
      showHome(s);
    } catch (e) {
      setMsg(e.message === 'NOT_CONFIGURED'
        ? 'The app is not connected to the back end yet.'
        : 'Could not reach the server.  Check your signal and try again.');
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  }

  async function doLogout() {
    if (!confirm('Sign out of SFM Receipts on this phone?')) return;
    const s = loadSession();
    clearSession();
    showLogin('');
    if (s && navigator.onLine) { try { await api('logout', { token: s.token }); } catch (e) { /* ignore */ } }
  }

  /* Refresh car list / categories whenever there's signal, so pick lists work offline. */
  async function refreshData() {
    const s = loadSession();
    if (!s || !navigator.onLine || !API) return;
    try {
      const r = await api('bootstrap', { token: s.token });
      if (r.ok) {
        Object.assign(s, { user: r.user, cars: r.cars, myCarId: r.myCarId, categories: r.categories });
        saveSession(s);
        if (!$('screenHome').classList.contains('hidden')) showHome(s);
      } else if (r.error === 'LOGGED_OUT') {
        clearSession();
        showLogin('Please sign in again.');
      }
    } catch (e) { /* weak signal: keep using the saved copy */ }
  }

  /* ---------- Signal indicator ---------- */
  function updateNet() {
    const n = $('netStatus');
    if (navigator.onLine) { n.textContent = ''; n.className = 'net'; }
    else { n.textContent = 'No service'; n.className = 'net offline'; }
  }

  /* ---------- Wire up ---------- */
  function init() {
    $('btnLogin').addEventListener('click', doLogin);
    $('loginPin').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    $('lnkLogout').addEventListener('click', e => { e.preventDefault(); doLogout(); });
    $('btnGas').addEventListener('click', () => { $('soonTitle').textContent = 'Gas'; show('screenSoon'); });
    $('btnPurchase').addEventListener('click', () => { $('soonTitle').textContent = 'Purchase'; show('screenSoon'); });
    document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => {
      const s = loadSession(); if (s) showHome(s); else showLogin();
    }));
    window.addEventListener('online', () => { updateNet(); refreshData(); });
    window.addEventListener('offline', updateNet);
    updateNet();

    try { $('loginName').value = localStorage.getItem('sfm_last_name') || ''; } catch (e) { /* ignore */ }

    const s = loadSession();
    if (s) { showHome(s); refreshData(); } else { showLogin(); }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
