/* SFM Receipts - phone app */
(function () {
  'use strict';

  const API = window.SFM_API_URL || '';
  const KEY = 'sfm_session';
  const OTHER = '__other';
  const $ = id => document.getElementById(id);

  /* =========================================================
   * Session stored on the phone
   * ========================================================= */
  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && s.token && s.expires > Date.now()) return s;
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveSession(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }
  function clearSession() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }

  /* =========================================================
   * Back end calls
   * ========================================================= */
  async function api(action, data, timeoutMs) {
    if (!API) throw new Error('NOT_CONFIGURED');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
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

  /* =========================================================
   * Outbox: entries saved on the phone until they reach the server
   * (IndexedDB survives closing the app and restarting the phone)
   * ========================================================= */
  const Outbox = (function () {
    let dbp = null;
    function db() {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          const r = indexedDB.open('sfm-receipts', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id' });
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      }
      return dbp;
    }
    async function tx(mode, fn) {
      const d = await db();
      return new Promise((res, rej) => {
        const t = d.transaction('outbox', mode);
        const store = t.objectStore('outbox');
        const out = fn(store);
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
        t.onerror = () => rej(t.error);
      });
    }
    return {
      put: item => tx('readwrite', s => s.put(item)),
      remove: id => tx('readwrite', s => s.delete(id)),
      all: () => tx('readonly', s => s.getAll()),
      count: () => tx('readonly', s => s.count())
    };
  })();

  let flushing = false;
  async function flushOutbox() {
    if (flushing || !navigator.onLine || !API) return;
    const s = loadSession();
    if (!s) return;
    flushing = true;
    try {
      const items = await Outbox.all();
      for (const item of items) {
        try {
          const r = await api(item.action, { token: s.token, data: item.data }, 90000);
          if (r.ok) {
            await Outbox.remove(item.id);
          } else if (r.error === 'LOGGED_OUT') {
            clearSession();
            showLogin('Please sign in again.  Your saved receipts will send after you sign in.');
            break;
          } else {
            item.lastError = r.error || 'Error';
            await Outbox.put(item);
          }
        } catch (e) {
          break; // weak or no signal: try again later
        }
      }
    } finally {
      flushing = false;
      updateQueueInfo();
    }
  }

  async function updateQueueInfo() {
    let n = 0;
    try { n = await Outbox.count(); } catch (e) { /* ignore */ }
    const q = $('queueInfo');
    if (n > 0) {
      q.textContent = 'Waiting to send: ' + n + (n === 1 ? ' entry' : ' entries') +
        '.  It will send automatically when you have signal.';
      q.classList.remove('hidden');
    } else {
      q.classList.add('hidden');
    }
    return n;
  }

  /* =========================================================
   * Screens
   * ========================================================= */
  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    $(id).classList.remove('hidden');
    document.body.classList.toggle('wide', $(id).classList.contains('wide'));
    window.scrollTo(0, 0);
  }

  function showLogin(msg) {
    $('loginPin').value = '';
    setMsg($('loginMsg'), msg || '');
    show('screenLogin');
  }

  function setMsg(el, text, ok) {
    el.textContent = text;
    el.className = 'msg' + (ok ? ' ok' : '');
  }

  function showHome(s) {
    $('helloName').textContent = s.user.name;
    const car = (s.cars || []).find(c => c.id === s.myCarId);
    $('myCar').textContent = car ? 'Your car: ' + car.label : '';
    $('sessionInfo').textContent = 'Signed in until ' + new Date(s.expires).toLocaleDateString();
    showInstallTip();
    updateQueueInfo();
    $('mgmtNav').classList.toggle('hidden', !isMgmt(s));
    renderMyCompliance(s);
    show('screenHome');
  }

  function goHome() {
    const s = loadSession();
    if (s) showHome(s); else showLogin();
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

  /* =========================================================
   * Login / logout
   * ========================================================= */
  async function doLogin() {
    const msg = $('loginMsg');
    const name = $('loginName').value.trim();
    const pin = $('loginPin').value.trim();
    if (!name || !/^\d{6}$/.test(pin)) { setMsg(msg, 'Enter your first name and 6-digit PIN.'); return; }
    if (!navigator.onLine) { setMsg(msg, 'No service.  You need a signal to sign in the first time.'); return; }

    const btn = $('btnLogin');
    btn.disabled = true; btn.textContent = 'Signing in…'; setMsg(msg, '');
    try {
      const r = await api('login', { name: name, pin: pin });
      if (!r.ok) { setMsg(msg, r.error || 'Sign-in failed.'); return; }
      const s = { token: r.token, expires: r.expires, user: r.user, cars: r.cars,
                  myCarId: r.myCarId, categories: r.categories, compliance: r.compliance, missing: r.missing };
      saveSession(s);
      try { localStorage.setItem('sfm_last_name', s.user.name); } catch (e) { /* ignore */ }
      showHome(s);
      flushOutbox();
    } catch (e) {
      setMsg(msg, e.message === 'NOT_CONFIGURED'
        ? 'The app is not connected to the back end yet.'
        : 'Could not reach the server.  Check your signal and try again.');
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  }

  async function doLogout() {
    const pending = await updateQueueInfo();
    const warn = pending
      ? 'You have ' + pending + ' entr' + (pending === 1 ? 'y' : 'ies') + ' still waiting to send.  They will stay on this phone and send after you sign in again.\n\nSign out?'
      : 'Sign out of SFM Receipts on this phone?';
    if (!confirm(warn)) return;
    const s = loadSession();
    clearSession();
    showLogin('');
    if (s && navigator.onLine) { try { await api('logout', { token: s.token }); } catch (e) { /* ignore */ } }
  }

  /* Keep car list / categories fresh whenever there's signal, so pick lists work offline. */
  async function refreshData() {
    const s = loadSession();
    if (!s || !navigator.onLine || !API) return;
    try {
      const r = await api('bootstrap', { token: s.token });
      if (r.ok) {
        Object.assign(s, { user: r.user, cars: r.cars, myCarId: r.myCarId, categories: r.categories, compliance: r.compliance, missing: r.missing });
        saveSession(s);
        if (!$('screenHome').classList.contains('hidden')) showHome(s);
      } else if (r.error === 'LOGGED_OUT') {
        clearSession();
        showLogin('Please sign in again.');
      }
    } catch (e) { /* weak signal: keep using the saved copy */ }
  }

  /* =========================================================
   * Photos: take, shrink to ~1600px JPEG
   * ========================================================= */
  let photoTarget = null;

  function takePhoto(kind) {
    photoTarget = kind;
    const input = $('cameraInput');
    input.value = '';
    input.click();
  }

  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not open photo')); };
      img.src = url;
    });
  }

  async function shrinkPhoto(file) {
    const img = await loadImage(file);
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.72).split(',')[1];
  }

  /* =========================================================
   * Readings: AI value with Confirm / Incorrect, or typed value
   * ========================================================= */
  // state: 'none' | 'reading' | 'ai' | 'confirmed' | 'manual'
  let cur = null;   // the entry being filled in (gas or purchase)

  function newField() { return { state: 'none', ai: null, value: '', note: '' }; }

  function fmt(field, v) {
    if (v === '' || v == null) return '';
    if (field === 'total') return '$' + Number(v).toFixed(2);
    if (field === 'odometer') return Number(v).toLocaleString();
    return String(v);
  }

  function renderReading(field) {
    const el = $(cur.screen).querySelector('.reading[data-field="' + field + '"]');
    const f = cur.fields[field];
    const label = el.dataset.label;
    if (f.state === 'none') { el.innerHTML = ''; return; }
    if (f.state === 'reading') {
      el.innerHTML = '<div class="busy">Reading ' + label.toLowerCase() + ' from photo…</div>';
      return;
    }
    if (f.state === 'ai') {
      el.innerHTML = '<div class="r-label">' + label + '</div>' +
        '<div class="r-value">' + fmt(field, f.ai) + '</div>' +
        '<div class="r-btns"><button class="yes" data-act="confirm">Confirm</button>' +
        '<button class="no" data-act="incorrect">Incorrect</button></div>';
    } else if (f.state === 'confirmed') {
      el.innerHTML = '<div class="r-label">' + label + '</div>' +
        '<div class="r-value ok">' + fmt(field, f.value) + '</div>' +
        '<button class="change" data-act="incorrect">Change</button>';
    } else if (f.state === 'manual') {
      const mode = field === 'odometer' ? 'numeric' : 'decimal';
      el.innerHTML = '<div class="r-label">' + label + (field === 'total' ? ' ($)' : '') + '</div>' +
        (f.note ? '<div class="r-note">' + f.note + '</div>' : '') +
        '<input inputmode="' + mode + '" data-act="type" value="' + (f.value || '') + '" placeholder="Type ' + label.toLowerCase() + '">';
    }
  }

  function onReadingClick(e) {
    const act = e.target.dataset.act;
    const el = e.target.closest('.reading');
    if (!act || !el) return;
    const field = el.dataset.field;
    const f = cur.fields[field];
    if (act === 'confirm') { f.value = f.ai; f.state = 'confirmed'; renderReading(field); }
    if (act === 'incorrect') {
      f.value = ''; f.note = 'Type the correct ' + el.dataset.label.toLowerCase() + '.';
      f.state = 'manual'; renderReading(field);
      const inp = el.querySelector('input'); if (inp) inp.focus();
    }
  }

  function onReadingInput(e) {
    if (e.target.dataset.act !== 'type') return;
    const field = e.target.closest('.reading').dataset.field;
    cur.fields[field].value = e.target.value.replace(/[$,\s]/g, '');
  }

  function setManual(fields, note) {
    fields.forEach(k => {
      const f = cur.fields[k];
      if (f.state !== 'confirmed') { f.state = 'manual'; f.note = note; }
      renderReading(k);
    });
  }

  async function readWithAI(kind, fields, base64) {
    const apiKind = kind.split('_')[0];
    if (!navigator.onLine) {
      $(cur.noService).classList.remove('hidden');
      setManual(fields, '');
      if (kind === 'receipt') renderUnclear();
      return;
    }
    fields.forEach(k => { cur.fields[k] = newField(); cur.fields[k].state = 'reading'; renderReading(k); });
    const s = loadSession();
    let r = null;
    try { r = await api('readPhoto', { token: s && s.token, kind: apiKind, image: base64 }, 45000); }
    catch (e) { r = null; }
    if (!r || !r.ok) {
      if (kind === 'receipt') renderUnclear();
      setManual(fields, r && r.error === 'LOGGED_OUT'
        ? 'Please type it in.'
        : "Couldn't read the photo right now.  Please type it in.");
      return;
    }
    cur.ai[kind] = r.fields;
    fields.forEach(k => {
      const raw = r.fields[k.split('_')[0]];
      const v = raw == null ? null : Number(String(raw).replace(/[$,\s]/g, ''));
      const f = cur.fields[k];
      if (v == null || raw === '' || isNaN(v)) {
        f.state = 'manual'; f.note = "Couldn't read this clearly.  Please type it in.";
      } else {
        f.ai = Number(v); f.state = 'ai';
      }
      renderReading(k);
    });
    if (kind === 'receipt') renderUnclear();
  }

  /* =========================================================
   * Gas entry
   * ========================================================= */
  let gas = null;

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function linkedText(item) {
    return 'Entering a missed ' + (item.kind === 'Gas' ? 'fill-up' : 'purchase') + ':  <b>' + usDate(item.date) + '</b> ' +
      esc(item.merchant) + ' <b>' + money(item.amount) + '</b>';
  }

  function startGas(item) {
    if (item && item.target) item = null;   // called from a button click
    const s = loadSession();
    if (!s) { showLogin(); return; }
    cur = gas = {
      screen: 'screenGas', noService: 'gasNoService', msg: 'gasMsg',
      clientId: uuid(), capturedAt: new Date().toISOString(),
      photos: { pump: null, odometer: null }, ai: { pump: null, odometer: null },
      fields: { total: newField(), gallons: newField(), odometer: newField() }
    };
    const sel = $('gasCar');
    sel.innerHTML = '';
    if (!s.myCarId) sel.add(new Option('Choose vehicle…', ''));
    (s.cars || []).forEach(c => sel.add(new Option(c.label, c.id)));
    sel.add(new Option('Not an SFM vehicle (rental, etc.)', OTHER));
    sel.value = s.myCarId || '';
    gas.pumpKeys = ['pump'];
    gas.nextPump = 1;
    $('extraPumps').innerHTML = '';
    $('pumpSum').textContent = '';
    gas.charge = item || null;
    $('gasLinked').innerHTML = item ? linkedText(item) : '';
    $('gasLinked').classList.toggle('hidden', !item);
    $('odoTitle').textContent = item ? '2.  Odometer (if you have it)' : '2.  Odometer';
    $('odoManualWrap').classList.toggle('hidden', !item);
    $('gasOdoManual').value = '';
    $('btnAddPump').classList.toggle('hidden', !!item);
    $('pumpHint').classList.toggle('hidden', !!item);
    $('gasOtherDesc').value = '';
    $('gasOtherWrap').classList.add('hidden');
    $('gasNoService').classList.toggle('hidden', navigator.onLine);
    ['pumpThumb', 'odometerThumb'].forEach(id => { $(id).src = ''; $(id).classList.add('hidden'); });
    $('screenGas').querySelectorAll('[data-photo]').forEach(b => { b.textContent = 'Take photo'; });
    ['total', 'gallons', 'odometer'].forEach(renderReading);
    setMsg($('gasMsg'), '');
    show('screenGas');
  }

  async function onPhotoChosen() {
    const file = $('cameraInput').files[0];
    if (photoTarget === 'catchup') { if (file) cuPhoto(file); return; }
    if (!file || !cur || !photoTarget) return;
    const kind = photoTarget;
    let b64;
    try { b64 = await shrinkPhoto(file); }
    catch (e) { setMsg($(cur.msg), 'That photo could not be opened.  Please try again.'); return; }
    cur.photos[kind] = b64;
    cur.ai[kind] = null;
    const thumb = $(kind + 'Thumb');
    thumb.src = 'data:image/jpeg;base64,' + b64;
    thumb.classList.remove('hidden');
    $(cur.screen).querySelector('[data-photo="' + kind + '"]').textContent = 'Retake photo';
    setMsg($(cur.msg), '');
    const sfx = kind.indexOf('_') > -1 ? kind.slice(kind.indexOf('_')) : '';
    const fieldsFor = kind.indexOf('pump') === 0 ? ['total' + sfx, 'gallons' + sfx]
      : kind === 'odometer' ? ['odometer'] : ['total'];
    await readWithAI(kind, fieldsFor, b64);
    updatePumpSum();
  }

  function fieldValue(k) {
    const f = cur.fields[k];
    if (f.state === 'confirmed' || f.state === 'manual') {
      const n = Number(f.value);
      return f.value !== '' && !isNaN(n) && n > 0 ? n : null;
    }
    return null;
  }

  async function submitGas() {
    const msg = $('gasMsg');
    const carId = $('gasCar').value;
    const other = $('gasOtherDesc').value.trim();
    if (!carId) return setMsg(msg, 'Choose the vehicle.');
    if (carId === OTHER && !other) return setMsg(msg, 'Describe the vehicle (for example, "Avis rental").');
    const keys = gas.pumpKeys;
    for (let i = 0; i < keys.length; i++) {
      if (!gas.photos[keys[i]]) return setMsg(msg, keys.length > 1
        ? 'Take a photo of pump receipt ' + (i + 1) + ' (or remove it).'
        : 'Take a photo of the pump display or receipt.');
    }
    if (!gas.photos.odometer && !gas.charge) return setMsg(msg, 'Take a photo of the odometer.');

    const allFields = Object.keys(gas.fields);
    if (allFields.some(k => gas.fields[k].state === 'reading')) return setMsg(msg, 'Still reading the photo.  One moment…');
    if (allFields.some(k => gas.fields[k].state === 'ai')) return setMsg(msg, 'Tap Confirm or Incorrect for each reading.');

    const pumps = [];
    for (let i = 0; i < keys.length; i++) {
      const sfx = keys[i].indexOf('_') > -1 ? keys[i].slice(keys[i].indexOf('_')) : '';
      const t = fieldValue('total' + sfx), g = fieldValue('gallons' + sfx);
      const which = keys.length > 1 ? ' for pump receipt ' + (i + 1) : '';
      if (t == null) return setMsg(msg, 'Enter the sale total' + which + '.');
      if (g == null) return setMsg(msg, 'Enter the gallons' + which + '.');
      pumps.push({ total: t, gallons: g, photo: gas.photos[keys[i]], ai: gas.ai[keys[i]] });
    }
    let odometer = fieldValue('odometer');
    if (gas.charge && !gas.photos.odometer) {
      const typed = $('gasOdoManual').value.replace(/[,\s]/g, '');
      odometer = typed === '' ? null : Number(typed);
      if (odometer != null && (isNaN(odometer) || odometer <= 0 || Math.round(odometer) !== odometer))
        return setMsg(msg, 'Enter the mileage in whole miles, or leave it blank.');
    } else if (odometer == null || Math.round(odometer) !== odometer) return setMsg(msg, 'Enter the odometer in whole miles.');

    const total = Math.round(pumps.reduce((a, p) => a + p.total, 0) * 100) / 100;
    const gallons = Math.round(pumps.reduce((a, p) => a + p.gallons, 0) * 1000) / 1000;
    const ppg = total / gallons;
    if (ppg < 1.5 || ppg > 10) {
      if (!confirm('That works out to $' + ppg.toFixed(2) + ' per gallon.  Are the totals and gallons right?')) return;
    }

    const data = {
      clientId: gas.clientId, capturedAt: gas.capturedAt,
      carId: carId === OTHER ? '' : carId, otherCar: carId === OTHER ? other : '',
      total: total, gallons: gallons, odometer: odometer,
      pumps: pumps, pumpPhoto: pumps[0].photo, odometerPhoto: gas.photos.odometer,
      ai: { pump: pumps[0].ai, odometer: gas.ai.odometer },
      enteredOffline: pumps.some(p => !p.ai) || (!!gas.photos.odometer && !gas.ai.odometer),
      chargeId: gas.charge ? gas.charge.chargeId : ''
    };
    if (gas.charge) dropMissing(gas.charge.chargeId);

    await saveAndSend('submitGas', data, $('btnGasSubmit'), msg, 'gas entry');
    gas = null;
  }

  async function saveAndSend(action, data, btn, msg, what) {
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await Outbox.put({ id: data.clientId, action: action, data: data, savedAt: Date.now() });
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Submit';
      setMsg(msg, 'Could not save on this phone.  Please try again.');
      return;
    }
    btn.textContent = 'Sending…';
    await flushOutbox();
    const all = await Outbox.all().catch(() => []);
    const stillHere = all.some(i => i.id === data.clientId);
    btn.disabled = false; btn.textContent = 'Submit';
    cur = null;
    if (!stillHere) {
      refreshData();
      $('doneTitle').textContent = 'Sent';
      $('doneText').textContent = 'Thanks!  Your ' + what + ' was submitted.';
    } else {
      $('doneTitle').textContent = 'Saved on your phone';
      $('doneText').textContent = 'No service right now.  Your ' + what + ' is saved and will send automatically when you have signal.  You can close the app.';
    }
    show('screenDone');
  }


  function addPump() {
    const i = gas.nextPump++;
    const key = 'pump_' + i;
    gas.pumpKeys.push(key);
    gas.photos[key] = null; gas.ai[key] = null;
    gas.fields['total_' + i] = newField(); gas.fields['gallons_' + i] = newField();
    const n = gas.pumpKeys.length;
    const div = document.createElement('div');
    div.className = 'part'; div.dataset.pump = key;
    div.innerHTML = '<div class="part-head">Pump receipt ' + n +
      ' <button class="change" data-remove-pump="' + key + '">Remove</button></div>' +
      '<button class="photo-btn" data-photo="' + key + '">Take photo</button>' +
      '<img id="' + key + 'Thumb" class="thumb hidden" alt="">' +
      '<div class="reading" data-field="total_' + i + '" data-label="Total"></div>' +
      '<div class="reading" data-field="gallons_' + i + '" data-label="Gallons"></div>';
    $('extraPumps').appendChild(div);
    div.querySelector('[data-photo]').addEventListener('click', () => takePhoto(key));
    renumberPumps();
    updatePumpSum();
  }

  function removePump(key) {
    const i = key.split('_')[1];
    gas.pumpKeys = gas.pumpKeys.filter(k => k !== key);
    delete gas.photos[key]; delete gas.ai[key];
    delete gas.fields['total_' + i]; delete gas.fields['gallons_' + i];
    const el = $('extraPumps').querySelector('[data-pump="' + key + '"]');
    if (el) el.remove();
    renumberPumps();
    updatePumpSum();
  }

  function renumberPumps() {
    $('extraPumps').querySelectorAll('.part').forEach((el, idx) => {
      el.querySelector('.part-head').firstChild.textContent = 'Pump receipt ' + (idx + 2) + ' ';
    });
  }

  function updatePumpSum() {
    if (!gas || cur !== gas) return;
    const el = $('pumpSum');
    if (gas.pumpKeys.length < 2) { el.textContent = ''; return; }
    let t = 0, g = 0;
    gas.pumpKeys.forEach(k => {
      const sfx = k.indexOf('_') > -1 ? k.slice(k.indexOf('_')) : '';
      const f1 = gas.fields['total' + sfx], f2 = gas.fields['gallons' + sfx];
      const v1 = f1 && (f1.state === 'confirmed' || f1.state === 'manual') ? Number(f1.value) : (f1 && f1.ai) || 0;
      const v2 = f2 && (f2.state === 'confirmed' || f2.state === 'manual') ? Number(f2.value) : (f2 && f2.ai) || 0;
      t += Number(v1) || 0; g += Number(v2) || 0;
    });
    el.textContent = 'Fill-up total: $' + t.toFixed(2) + ', ' + (Math.round(g * 1000) / 1000) + ' gallons';
    el.className = 'split-left good';
  }

  /* =========================================================
   * Purchase entry
   * ========================================================= */
  let pur = null;

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function purchaseCategories() {
    const s = loadSession();
    return ((s && s.categories) || []).filter(c => !/^gas\b/i.test(c));
  }

  function categorySelect(selected) {
    return '<option value="">Choose category…</option>' + purchaseCategories().map(c =>
      '<option' + (c === selected ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
  }

  function startPurchase(item) {
    if (item && item.target) item = null;   // called from a button click
    const s = loadSession();
    if (!s) { showLogin(); return; }
    cur = pur = {
      screen: 'screenPurchase', noService: 'purNoService', msg: 'purMsg',
      clientId: uuid(), capturedAt: new Date().toISOString(),
      photos: { receipt: null }, ai: { receipt: null },
      fields: { total: newField() }, unclear: [], itemNotes: {}, split: false, parts: []
    };
    pur.charge = item || null;
    $('purLinked').innerHTML = item ? linkedText(item) : '';
    $('purLinked').classList.toggle('hidden', !item);
    $('purCategory').innerHTML = categorySelect('');
    $('purNote').value = '';
    $('purNoteReq').textContent = '(optional)';
    $('unclearItems').innerHTML = '';
    $('receiptThumb').src = ''; $('receiptThumb').classList.add('hidden');
    $('screenPurchase').querySelector('[data-photo]').textContent = 'Take photo';
    $('purNoService').classList.toggle('hidden', navigator.onLine);
    setSplit(false);
    renderReading('total');
    setMsg($('purMsg'), '');
    show('screenPurchase');
  }

  /* Items the AI couldn't identify: ask what each one is (required). */
  function renderUnclear() {
    const items = ((pur && pur.ai.receipt && pur.ai.receipt.items) || [])
      .filter(i => i && i.clear === false && i.description);
    pur.unclear = items;
    $('unclearItems').innerHTML = items.map((it, i) =>
      '<div class="unclear"><div class="q">What is "' + esc(it.description) + '"' +
      (it.amount != null && !isNaN(Number(it.amount)) ? ' ($' + Number(it.amount).toFixed(2) + ')' : '') +
      '?</div><input data-unclear="' + i + '" placeholder="e.g. wire cutters" value="' +
      esc(pur.itemNotes[it.description] || '') + '"></div>').join('');
    if (!pur.ai.receipt) $('purNoteReq').textContent = "(add one if any item on the receipt isn't obvious)";
    else $('purNoteReq').textContent = '(optional)';
  }

  function setSplit(on) {
    pur.split = on;
    $('singleCat').classList.toggle('hidden', on);
    $('splitBox').classList.toggle('hidden', !on);
    if (on && !pur.parts.length) {
      pur.parts = [{ amount: '', category: $('purCategory').value, note: '' },
                   { amount: '', category: '', note: '' }];
    }
    if (on) renderParts();
  }

  function renderParts() {
    $('partsList').innerHTML = pur.parts.map((p, i) =>
      '<div class="part" data-part="' + i + '">' +
      '<div class="part-head">Part ' + (i + 1) +
      (pur.parts.length > 2 ? '<button class="change" data-remove="' + i + '">Remove</button>' : '') + '</div>' +
      '<input inputmode="decimal" data-k="amount" placeholder="Amount ($)" value="' + esc(p.amount) + '">' +
      '<select data-k="category">' + categorySelect(p.category) + '</select>' +
      '<input data-k="note" placeholder="Note (what is it?)" value="' + esc(p.note) + '">' +
      '</div>').join('');
    updateSplitLeft();
  }

  function purTotal() {
    const f = pur.fields.total;
    if (f.state === 'confirmed' || f.state === 'manual') {
      const n = Number(f.value);
      return f.value !== '' && !isNaN(n) && n > 0 ? n : null;
    }
    return null;
  }

  function updateSplitLeft() {
    if (!pur || !pur.split) return;
    const el = $('splitLeft');
    const total = purTotal();
    const sum = pur.parts.reduce((a, p) => a + (Number(p.amount) || 0), 0);
    if (total == null) { el.textContent = 'Confirm the receipt total first.'; el.className = 'split-left'; return; }
    const left = Math.round((total - sum) * 100) / 100;
    if (Math.abs(left) < 0.005) { el.textContent = 'Parts add up to $' + total.toFixed(2) + '  ✓'; el.className = 'split-left good'; }
    else if (left > 0) { el.textContent = 'Left to assign: $' + left.toFixed(2); el.className = 'split-left off'; }
    else { el.textContent = 'Parts are $' + (-left).toFixed(2) + ' over the total'; el.className = 'split-left off'; }
  }

  function onPurchaseInput(e) {
    const t = e.target;
    if (t.dataset.unclear != null) {
      const it = pur.unclear[Number(t.dataset.unclear)];
      if (it) pur.itemNotes[it.description] = t.value;
      return;
    }
    const partEl = t.closest('.part');
    if (partEl && t.dataset.k) {
      pur.parts[Number(partEl.dataset.part)][t.dataset.k] = t.dataset.k === 'amount'
        ? t.value.replace(/[$,\s]/g, '') : t.value;
      updateSplitLeft();
    }
    if (t.dataset.act === 'type') updateSplitLeft();
  }

  function onPurchaseClick(e) {
    const t = e.target;
    if (t.dataset.remove != null) {
      pur.parts.splice(Number(t.dataset.remove), 1);
      renderParts();
    }
    if (t.dataset.act) setTimeout(updateSplitLeft, 0);
  }

  async function submitPurchase() {
    const msg = $('purMsg');
    if (!pur.photos.receipt) return setMsg(msg, 'Take a photo of the receipt.');
    const st = pur.fields.total.state;
    if (st === 'reading') return setMsg(msg, 'Still reading the photo.  One moment…');
    if (st === 'ai') return setMsg(msg, 'Tap Confirm or Incorrect for the total.');
    const total = purTotal();
    if (total == null) return setMsg(msg, 'Enter the receipt total.');

    const missing = pur.unclear.filter(it => !(pur.itemNotes[it.description] || '').trim());
    if (missing.length) return setMsg(msg, 'Tell us what each unclear item is (the yellow boxes).');

    let parts;
    const note = $('purNote').value.trim();
    if (!pur.split) {
      const cat = $('purCategory').value;
      if (!cat) return setMsg(msg, 'Choose a category.');
      parts = [{ amount: total, category: cat, note: '' }];
    } else {
      for (let i = 0; i < pur.parts.length; i++) {
        const p = pur.parts[i];
        if (!(Number(p.amount) > 0)) return setMsg(msg, 'Enter an amount for part ' + (i + 1) + '.');
        if (!p.category) return setMsg(msg, 'Choose a category for part ' + (i + 1) + '.');
      }
      const sum = pur.parts.reduce((a, p) => a + Number(p.amount), 0);
      if (Math.abs(sum - total) > 0.005) return setMsg(msg, 'The parts must add up to the total ($' + total.toFixed(2) + ').');
      parts = pur.parts.map(p => ({ amount: Number(p.amount), category: p.category, note: p.note.trim() }));
    }

    const data = {
      clientId: pur.clientId, capturedAt: pur.capturedAt, total: total,
      receiptPhoto: pur.photos.receipt, parts: parts, note: note,
      itemNotes: pur.unclear.map(it => ({ description: it.description, note: (pur.itemNotes[it.description] || '').trim() })),
      ai: { receipt: pur.ai.receipt }, enteredOffline: !pur.ai.receipt,
      chargeId: pur.charge ? pur.charge.chargeId : ''
    };
    if (pur.charge) dropMissing(pur.charge.chargeId);
    await saveAndSend('submitPurchase', data, $('btnPurSubmit'), msg, 'purchase receipt');
    pur = null;
  }


  /* =========================================================
   * SFM Management (desktop): Open Items, search, statement import
   * ========================================================= */
  function isMgmt(s) { return s && s.user && (s.user.role === 'Owner' || s.user.role === 'Accountant'); }

  function money(v) { return v == null || v === '' ? '' : (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toFixed(2); }
  function usDate(d) { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[2] + '/' + m[3] + '/' + m[1] : (d || ''); }
  function links(r) {
    return (r.receiptPhoto ? '<a href="' + esc(r.receiptPhoto) + '" target="_blank" rel="noopener">Receipt</a>' : '') +
           (r.odometerPhoto ? '<a href="' + esc(r.odometerPhoto) + '" target="_blank" rel="noopener">Odometer</a>' : '');
  }

  async function mgmtCall(action, data, msgEl) {
    const s = loadSession();
    if (!s) { showLogin(); return null; }
    if (!navigator.onLine) { if (msgEl) msgEl.textContent = 'No service.  These screens need a connection.'; return null; }
    try {
      const r = await api(action, Object.assign({ token: s.token }, data || {}), 120000);
      if (r.error === 'LOGGED_OUT') { clearSession(); showLogin('Please sign in again.'); return null; }
      if (!r.ok && msgEl) msgEl.textContent = r.error || 'Something went wrong.';
      return r.ok ? r : null;
    } catch (e) {
      if (msgEl) msgEl.textContent = 'Could not reach the server.  Try again.';
      return null;
    }
  }

  /* ----- Open Items ----- */
  let openData = [];

  async function loadOpenItems() {
    show('screenOpen');
    $('openSummary').textContent = 'Loading…';
    $('openList').innerHTML = '';
    const r = await mgmtCall('openItems', {}, $('openSummary'));
    if (!r) return;
    openData = r.items;
    renderOpenItems();
  }

  function renderOpenItems() {
    const f = $('openFilter').value, who = $('openWho').value.trim().toLowerCase();
    const items = openData.filter(i => (!f || i.color === f) && (!who || i.cardholder.toLowerCase().indexOf(who) === 0));
    const red = openData.filter(i => i.color === 'red').length, yel = openData.length - red;
    $('openSummary').textContent = red + ' missing (red), ' + yel + ' late (yellow).  Items drop off once complete.';
    const groups = {};
    items.forEach(i => (groups[i.cardholder] = groups[i.cardholder] || []).push(i));
    $('openList').innerHTML = Object.keys(groups).sort().map(name => {
      const g = groups[name];
      const r = g.filter(i => i.color === 'red').length, y = g.length - r;
      return '<details class="person"' + (Object.keys(groups).length === 1 ? ' open' : '') + '><summary>' + esc(name) +
        (r ? '<span class="badge red">' + r + ' red</span>' : '') + (y ? '<span class="badge yellow">' + y + ' yellow</span>' : '') +
        '</summary><div class="results"><table class="grid"><tr><th>Date</th><th>Merchant</th><th class="num">Amount</th><th>What\'s missing</th><th>Receipt</th><th></th></tr>' +
        g.map(i => '<tr class="' + i.color + '"><td>' + usDate(i.date) + '</td><td>' + esc(i.merchant) +
          (i.category ? '<div class="sub2">' + esc(i.category) + (i.note ? ' · ' + esc(i.note) : '') + '</div>' : '') +
          '</td><td class="num">' + money(i.amount) + '</td><td>' + esc(i.issue) + '</td><td>' + links(i) + '</td><td>' +
          (i.color === 'yellow' && i.chargeId ? '<button class="change" data-review="' + esc(i.chargeId) + '">Mark OK</button>' : '') +
          '</td></tr>').join('') + '</table></div></details>';
    }).join('') || '<p class="sub">Nothing open.  Everything is complete.</p>';
  }

  async function markReviewed(id, btn) {
    btn.textContent = 'Saving…';
    const r = await mgmtCall('markReviewed', { chargeId: id });
    if (r) { openData = openData.filter(i => i.chargeId !== id); renderOpenItems(); }
    else btn.textContent = 'Mark OK';
  }

  /* ----- Find a Receipt ----- */
  async function doSearch() {
    const q = { amount: $('sAmount').value.replace(/[$,\s]/g, ''), text: $('sText').value.trim(),
                cardholder: $('sWho').value.trim(), from: $('sFrom').value, to: $('sTo').value };
    if (!q.amount && !q.text && !q.cardholder && !q.from && !q.to) { $('searchMsg').textContent = 'Enter at least one thing to search for.'; return; }
    $('searchMsg').textContent = 'Searching…';
    $('searchResults').innerHTML = '';
    const r = await mgmtCall('search', { query: q }, $('searchMsg'));
    if (!r) return;
    $('searchMsg').textContent = r.results.length + ' found' + (r.more ? ' (showing the first 300)' : '') + '.';
    if (!r.results.length) return;
    $('searchResults').innerHTML = '<div class="results"><table class="grid"><tr><th>Date</th><th>Cardholder</th><th>Store / merchant</th><th class="num">Amount</th><th>Category · QuickBooks account</th><th>Status</th><th>Photos</th></tr>' +
      r.results.map(x => {
        const parts = (x.parts || []).map(p => '<div class="sub2">' + esc(p.note || ('Part ' + p.n)) + ': ' + money(p.amount) +
          (p.gallons ? ', ' + p.gallons + ' gal' : '') + ' · ' + esc(p.category) + (p.account ? ' · ' + esc(p.account) : '') + '</div>').join('');
        const extra = x.kind === 'receipt'
          ? (x.gallons ? '<div class="sub2">' + x.gallons + ' gal' + (x.odometer ? ' · odometer ' + Number(x.odometer).toLocaleString() : '') + '</div>' : '') +
            (x.note ? '<div class="sub2">Note: ' + esc(x.note) + '</div>' : '')
          : '';
        return '<tr class="' + (x.kind === 'charge' && x.status === 'Missing receipt' ? 'red' : '') + '"><td>' + usDate(x.date) + '</td><td>' + esc(x.cardholder) +
          '</td><td>' + esc(x.merchant || '') + extra + '</td><td class="num">' + money(x.total) + '</td><td>' + esc(x.category || '') +
          (x.account ? '<div class="sub2">' + esc(x.account) + '</div>' : '') + parts + '</td><td>' +
          esc(x.kind === 'charge' ? x.status : (x.status === 'OK' ? (x.charges && x.charges.length ? 'Matched' : 'Waiting for statement') : x.status)) +
          '</td><td>' + links(x) + '</td></tr>';
      }).join('') + '</table></div>';
  }


  /* ----- Compliance: employee's own running total (home screen) ----- */
  function longDate(d) {
    const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return d || '';
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[2]) - 1] + ' ' + m[3] + ', ' + m[1];
  }

  let showAllMissing = false;

  function renderMyCompliance(s) {
    const el = $('myCompliance');
    if (!s || isMgmt(s) || (!s.compliance && !s.missing)) { el.classList.add('hidden'); return; }
    const c = s.compliance, m = s.missing || { items: [], count: 0, startDate: '' };
    const start = (c && c.countingFrom) || m.startDate;
    const today = new Date().toISOString().slice(0, 10);
    const yr = start && start > today ? start.slice(0, 4) : ((c && c.year) || today.slice(0, 4));
    let html = '<div class="mc-title">Your ' + yr + ' Receipts</div>';
    html += '<div class="policy">' + (start ? 'Receipt tracking begins ' + longDate(start) + '.  ' : '') +
      'Gas purchases must be entered at transaction.  Other purchases must be entered same day.  ' +
      'Best practice is to enter all immediately following transaction.</div>';
    if (c && start && start <= today) {
      const left = c.freeTotal - c.freeUsed;
      const what = c.plan === 'Bonus' ? 'Bonus' : 'Raise';
      html += '<div class="mc-line">Missed: <b>' + c.misses.length + '</b> (' + c.freeTotal + ' free per year, ' + left + ' left)</div>';
      html += '<div class="mc-line">' + what + ' impact so far: ' + (c.penaltyPct > 0
        ? '<span class="mc-bad">-' + c.penaltyPct + '%' + (c.penaltyDollars != null ? ' ($' + c.penaltyDollars.toFixed(2) + ')' : '') + '</span>'
        : '<span class="mc-good">none</span>') + '</div>';
    }
    const items = m.items || [];
    if (items.length) {
      const shown = showAllMissing ? items : items.slice(0, 8);
      html += '<div class="mc-line" style="margin-top:10px"><b>Still needed (' + m.count + '):</b>  Tap one to enter it.</div>' +
        shown.map(i => '<button class="missing-btn" data-charge="' + esc(i.chargeId) + '"><span><b>' + usDate(i.date) +
          '</b> ' + esc(i.merchant) + ' <b>' + money(i.amount) + '</b><br><span class="k">' + (i.kind === 'Gas' ? 'Gas' : 'Purchase') +
          '</span></span><span class="go">Enter &rsaquo;</span></button>').join('') +
        (items.length > shown.length ? '<button class="change" id="btnMoreMissing">Show all ' + items.length + '</button>' : '') +
        (m.count > items.length ? '<div class="k" style="margin-top:6px">Showing the newest ' + items.length + '.</div>' : '');
    } else if (start && start <= today) {
      html += '<div class="mc-line mc-good" style="margin-top:8px">Nothing missing.  Nice work!</div>';
    }
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  function onMissingClick(e) {
    if (e.target.id === 'btnMoreMissing') { showAllMissing = true; renderMyCompliance(loadSession()); return; }
    const btn = e.target.closest('[data-charge]');
    if (!btn) return;
    const s = loadSession();
    const item = ((s && s.missing && s.missing.items) || []).find(i => i.chargeId === btn.dataset.charge);
    if (!item) return;
    if (item.kind === 'Gas') startGas(item); else startPurchase(item);
  }

  /* Remove an item from the phone's missing list right after it's entered. */
  function dropMissing(chargeId) {
    const s = loadSession();
    if (!s || !s.missing || !chargeId) return;
    const before = s.missing.items.length;
    s.missing.items = s.missing.items.filter(i => i.chargeId !== chargeId);
    if (s.missing.items.length < before) s.missing.count = Math.max(0, s.missing.count - 1);
    saveSession(s);
  }

  /* ----- Compliance: management view ----- */
  async function loadCompliance() {
    show('screenCompliance');
    $('compMsg').textContent = 'Loading…';
    $('compList').innerHTML = '';
    const r = await mgmtCall('compliance', {}, $('compMsg'));
    if (!r) return;
    if (!r.people.length) { $('compMsg').textContent = 'No one has a compliance plan.  Set "Compliance Plan" on the Cardholders tab.'; return; }
    const p0 = r.people[0];
    $('compMsg').textContent = p0.year + ', counting card charges from ' + usDate(p0.countingFrom) +
      ' (Settings → Compliance Start Date).  Gas counts as missed if not entered the same day; other purchases at 30 days, with a warning at 15.  Plan rules are on the Compliance_Plans tab.';
    $('compList').innerHTML = r.people.map(c => {
      const imp = c.penaltyPct > 0 ? '-' + c.penaltyPct + '%' + (c.penaltyDollars != null ? ' ($' + c.penaltyDollars.toFixed(2) + ')' : ' (set Plan Base $ for dollars)') : 'none';
      const rowsHtml = c.misses.map(m => '<tr class="' + (m.free ? '' : 'red') + '"><td>' + usDate(m.date) + '</td><td>' + m.kind +
          '</td><td>' + esc(m.merchant) + '</td><td class="num">' + money(m.amount) + '</td><td>' + (m.free ? 'Free miss' : '-' + m.pct + '%') + '</td></tr>').join('') +
        c.warnings.map(w => '<tr class="yellow"><td>' + usDate(w.date) + '</td><td>Other</td><td>' + esc(w.merchant) + '</td><td class="num">' +
          money(w.amount) + '</td><td>15-day warning' + (w.pct ? ', -' + w.pct + '%' : '') + (w.entered ? ' (entered late)' : '') + '</td></tr>').join('');
      return '<details class="person"><summary>' + esc(c.name) + ' · ' + c.plan +
        (c.base != null ? ' ($' + Number(c.base).toLocaleString() + ')' : '') + ' — missed ' + c.misses.length +
        ', free used ' + c.freeUsed + '/' + c.freeTotal + ', impact ' + imp + '</summary><div class="results">' +
        '<p class="sub" style="padding:6px 8px">' + c.gasCharges + ' gas and ' + c.otherCharges + ' other charges counted · ' +
        c.openCount + ' still without a receipt</p>' +
        (rowsHtml ? '<table class="grid"><tr><th>Date</th><th>Type</th><th>Merchant</th><th class="num">Amount</th><th>Result</th></tr>' + rowsHtml + '</table>'
                  : '<p class="sub" style="padding:6px 8px">No misses.</p>') + '</div></details>';
    }).join('');
  }


  /* ----- Catch-up entry (old receipts, charge by charge) ----- */
  const cu = { items: [], idx: -1, data: null, photo: null, ai: null };

  function cuMonths() {
    const sel = $('cuMonth');
    if (sel.options.length) return;
    const y = new Date().getFullYear();
    sel.add(new Option('All ' + y, ''));
    ['January','February','March','April','May','June','July','August','September','October','November','December']
      .forEach((m, i) => sel.add(new Option(m + ' ' + y, y + '-' + ('0' + (i + 1)).slice(-2))));
  }

  async function openCatchup() {
    cuMonths();
    show('screenCatchup');
    if (!$('cuWho').options.length || $('cuWho').options.length < 2) await cuLoad();
  }

  async function cuLoad() {
    $('cuProgress').textContent = 'Loading…';
    $('cuCard').classList.add('hidden');
    const r = await mgmtCall('catchupList', { cardholder: $('cuWho').value, month: $('cuMonth').value }, $('cuProgress'));
    if (!r) return;
    const who = $('cuWho').value;
    if ($('cuWho').options.length < 2) {
      r.cardholders.forEach(n => $('cuWho').add(new Option(n, n)));
      $('cuWho').value = who;
    }
    cu.data = r;
    cu.items = r.items;
    $('cuCar').innerHTML = r.cars.map(c => '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>').join('') +
      '<option value="__other">Not an SFM vehicle (rental, etc.)</option><option value="">Unknown vehicle</option>';
    $('cuCategory').innerHTML = r.categories.map(c => '<option>' + esc(c) + '</option>').join('');
    if (!who) { $('cuProgress').textContent = 'Choose a cardholder to start.'; return; }
    cu.idx = -1;
    cuNext(1);
    if (cu.idx < 0) { cu.idx = cu.items.length; cuRender(); }
  }

  function cuVisible(i) { return !$('cuOpenOnly').checked || cu.items[i].status === 'Open'; }

  function cuNext(dir) {
    let i = cu.idx;
    do { i += dir; } while (i >= 0 && i < cu.items.length && !cuVisible(i));
    if (i < 0) return;
    cu.idx = i;
    cuRender();
  }

  function cuRender() {
    const done = cu.items.filter(x => x.status !== 'Open').length;
    $('cuProgress').textContent = cu.items.length
      ? done + ' of ' + cu.items.length + ' charges done for ' + $('cuWho').value + ($('cuMonth').value ? ' in this month' : ' this year') + '.'
      : 'No charges found.';
    if (cu.idx >= cu.items.length || cu.idx < 0) {
      $('cuCard').classList.add('hidden');
      if (cu.items.length) $('cuProgress').textContent += '  All done here.  Pick another month or cardholder.';
      return;
    }
    const it = cu.items[cu.idx];
    $('cuCard').classList.remove('hidden');
    cu.photo = null; cu.ai = null;
    $('cuPos').textContent = 'Charge ' + (cu.idx + 1) + ' of ' + cu.items.length + ' · ' + (it.bankCategory || '');
    $('cuCharge').innerHTML = '<b>' + usDate(it.date) + '</b> · ' + esc(it.merchant) + ' · <b>' + money(it.amount) + '</b>' +
      (it.status !== 'Open' ? '<span class="st ' + (it.status === 'Done' ? 'Done' : 'No') + '">' + esc(it.status) + '</span>' : '');
    document.querySelectorAll('input[name=cuKind]').forEach(r => { r.checked = r.value === it.kind; });
    $('cuThumb').src = ''; $('cuThumb').classList.add('hidden');
    $('cuAi').innerHTML = ''; $('cuMsg').textContent = '';
    $('cuCar').value = cu.data.defaultCarId || '';
    $('cuOtherCar').value = ''; $('cuOtherCar').classList.add('hidden');
    $('cuGallons').value = ''; $('cuMileage').value = ''; $('cuNote').value = '';
    $('cuCategory').value = it.guess;
    cuKindChanged();
    const locked = it.status === 'Done';
    ['btnCuSave', 'btnCuNone', 'btnCuPhoto'].forEach(id => { $(id).disabled = locked; });
    $('btnCuNone').textContent = it.status === 'No receipt' ? 'Undo "No receipt"' : 'No receipt';
    $('btnCuNone').disabled = it.status === 'Done';
  }

  function cuKind() { const r = document.querySelector('input[name=cuKind]:checked'); return r ? r.value : 'Other'; }
  function cuKindChanged() {
    $('cuGas').classList.toggle('hidden', cuKind() !== 'Gas');
    $('cuOther').classList.toggle('hidden', cuKind() === 'Gas');
  }

  async function cuPhoto(file) {
    let b64;
    try { b64 = await shrinkPhoto(file); } catch (e) { $('cuMsg').textContent = 'That image could not be opened.'; return; }
    cu.photo = b64; cu.ai = null;
    $('cuThumb').src = 'data:image/jpeg;base64,' + b64; $('cuThumb').classList.remove('hidden');
    $('cuAi').textContent = 'Reading receipt…';
    const it = cu.items[cu.idx];
    const r = await mgmtCall('catchupRead', { image: b64 }, $('cuMsg'));
    if (!r || !r.fields) { $('cuAi').textContent = "Couldn't read the receipt.  Fill in what you need."; return; }
    const f = r.fields; cu.ai = f;
    let line = '';
    if (f.total != null) line += Math.abs(Number(f.total) - it.amount) < 0.01
      ? '<span class="ok">Receipt total ' + money(f.total) + ' matches  ✓</span>'
      : '<span class="bad">Receipt shows ' + money(f.total) + ', card charge is ' + money(it.amount) + '</span>';
    if (f.unclearItems && f.unclearItems.length) line += '<br><span class="bad">Unclear item(s): ' + esc(f.unclearItems.join(', ')) + ' — add a note</span>';
    $('cuAi').innerHTML = line || 'Read the receipt, but no total was found.';
    if (f.gallons != null && !$('cuGallons').value) $('cuGallons').value = f.gallons;
    if (f.mileage != null && !$('cuMileage').value) $('cuMileage').value = f.mileage;
    (cuKind() === 'Gas' ? $('cuMileage') : $('cuNote')).focus();
  }

  async function cuSave() {
    const it = cu.items[cu.idx];
    if (!it) return;
    if (!cu.photo) { $('cuMsg').textContent = 'Add the receipt photo first (or use "No receipt").'; return; }
    const gas = cuKind() === 'Gas';
    const carSel = $('cuCar').value;
    if (gas && carSel === '__other' && !$('cuOtherCar').value.trim()) { $('cuMsg').textContent = 'Describe the vehicle.'; return; }
    const btn = $('btnCuSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    const r = await mgmtCall('catchupSave', { data: {
      chargeId: it.chargeId, kind: gas ? 'Gas' : 'Other', photo: cu.photo, ai: cu.ai,
      carId: gas && carSel && carSel !== '__other' ? carSel : '', otherCar: gas && carSel === '__other' ? $('cuOtherCar').value.trim() : '',
      gallons: gas ? $('cuGallons').value.replace(/[,\s]/g, '') : '', mileage: gas ? $('cuMileage').value.replace(/[,\s]/g, '') : '',
      category: gas ? '' : $('cuCategory').value, note: gas ? '' : $('cuNote').value.trim() } }, $('cuMsg'));
    btn.disabled = false; btn.textContent = 'Save & Next';
    if (!r) return;
    it.status = 'Done';
    cuNext(1);
    if (cu.idx >= 0 && cu.items[cu.idx] === it) { cu.idx = cu.items.length; cuRender(); }
  }

  async function cuNone() {
    const it = cu.items[cu.idx];
    if (!it) return;
    const undo = it.status === 'No receipt';
    const r = await mgmtCall('catchupNoReceipt', { chargeId: it.chargeId, undo: undo }, $('cuMsg'));
    if (!r) return;
    it.status = undo ? 'Open' : 'No receipt';
    if (undo) cuRender(); else { cuNext(1); if (cu.items[cu.idx] === it) { cu.idx = cu.items.length; cuRender(); } }
  }


  /* ----- Vehicles & MPG ----- */
  async function loadVehicles() {
    const sel = $('vehYear');
    if (!sel.options.length) { const y = new Date().getFullYear(); [y, y - 1].forEach(v => sel.add(new Option(String(v), String(v)))); sel.add(new Option('All years', '')); }
    show('screenVehicles');
    $('vehMsg').textContent = 'Loading…'; $('vehList').innerHTML = '';
    const r = await mgmtCall('vehicles', { year: sel.value }, $('vehMsg'));
    if (!r) return;
    $('vehMsg').textContent = 'MPG is figured between fills that have mileage; fills without mileage are covered by the next reading.  ' +
      'Flags: below ' + r.lowPct + '% of expected MPG (more gas than the miles explain) or above ' + r.highPct + '% (a fill may be missing).  ' +
      'Expected MPG is on the Cars tab.';
    $('vehList').innerHTML = r.vehicles.map(v => {
      const head = esc(v.label) + (v.driver ? ' · ' + esc(v.driver) : '') + ' — ' + v.fillCount + ' fills, ' + v.gallons + ' gal, ' +
        money(v.spent) + (v.mpg ? ', ' + v.mpg + ' MPG' : '') + (v.expected ? ' (expected ~' + v.expected + ')' : '') +
        (v.flagCount ? '<span class="badge red">' + v.flagCount + ' flag' + (v.flagCount > 1 ? 's' : '') + '</span>' : '') +
        (v.noMileage ? '<span class="badge yellow">' + v.noMileage + ' no mileage</span>' : '');
      const rows = v.fills.map(f => '<tr class="' + (f.flags.length ? 'red' : (f.odometer == null ? 'yellow' : '')) + '"><td>' + usDate(f.date) +
        '</td><td>' + esc(f.cardholder) + '</td><td class="num">' + (f.gallons != null ? f.gallons : '') + '</td><td class="num">' +
        (f.odometer != null ? Number(f.odometer).toLocaleString() : '') + '</td><td class="num">' + (f.miles != null ? f.miles.toLocaleString() : '') +
        '</td><td class="num">' + (f.mpg != null ? f.mpg : '') + '</td><td>' + esc(f.flags.join('; ') || f.note || '') +
        '</td><td>' + links(f) + '</td></tr>').join('');
      return '<details class="person"' + (v.flagCount ? ' open' : '') + '><summary>' + head + '</summary><div class="results">' +
        (rows ? '<table class="grid"><tr><th>Date</th><th>Driver</th><th class="num">Gallons</th><th class="num">Mileage</th><th class="num">Miles</th><th class="num">MPG</th><th>Notes</th><th>Photos</th></tr>' + rows + '</table>'
              : '<p class="sub" style="padding:6px 8px">No fill-ups yet.</p>') + '</div></details>';
    }).join('');
  }

  /* ----- Import ----- */
  let importRows = null;

  function parseCSV(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = ''; if (row.some(x => x !== '')) rows.push(row); row = [];
      } else field += ch;
    }
    row.push(field); if (row.some(x => x !== '')) rows.push(row);
    return rows;
  }

  function decodeHtml(t) { const el = document.createElement('textarea'); el.innerHTML = t; return el.value; }

  function isoFromUS(d) { const m = String(d).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2) : String(d).trim(); }

  async function onImportFile() {
    const file = $('impFile').files[0];
    $('impResult').textContent = ''; $('btnDoImport').classList.add('hidden'); importRows = null;
    if (!file) return;
    const source = $('impSource').value;
    const table = parseCSV(await file.text());
    const hdr = (table.shift() || []).map(h => h.trim().toLowerCase());
    const col = n => hdr.indexOf(n);
    if (source !== 'Chase' || col('card') === -1 || col('transaction date') === -1 || col('amount') === -1) {
      $('impPreview').textContent = source === 'TD'
        ? 'TD Bank files aren\'t set up yet.  Send one to Claude once the new cards are active.'
        : 'This doesn\'t look like a Chase activity file (no Card / Transaction Date / Amount columns).';
      return;
    }
    const from = $('impFrom').value;
    let skippedOld = 0, payments = 0;
    const cards = {};
    importRows = [];
    table.forEach(f => {
      const r = { card: f[col('card')], txnDate: f[col('transaction date')], postDate: f[col('post date')],
                  desc: decodeHtml(f[col('description')] || ''), bankCategory: f[col('category')] || '',
                  type: f[col('type')] || '', amount: f[col('amount')] };
      if (from && isoFromUS(r.txnDate) < from) { skippedOld++; return; }
      if (!/^(sale|return)$/i.test(r.type)) payments++;
      else cards[r.card] = true;
      importRows.push(r);
    });
    const dates = importRows.map(r => isoFromUS(r.txnDate)).sort();
    $('impPreview').textContent = (importRows.length - payments) + ' charges and returns from ' + usDate(dates[0]) + ' to ' +
      usDate(dates[dates.length - 1]) + ' on cards ' + Object.keys(cards).sort().join(', ') + '.  ' + payments +
      ' payments will be skipped' + (skippedOld ? ', plus ' + skippedOld + ' transactions before ' + usDate(from) : '') + '.';
    $('btnDoImport').classList.remove('hidden');
  }

  async function doImport() {
    if (!importRows) return;
    const btn = $('btnDoImport');
    btn.disabled = true; btn.textContent = 'Importing…';
    $('impResult').className = 'msg';
    const r = await mgmtCall('importCharges', { source: $('impSource').value, rows: importRows }, $('impResult'));
    btn.disabled = false; btn.textContent = 'Import';
    if (!r) return;
    $('impResult').className = 'msg ok';
    $('impResult').textContent = 'Imported ' + r.added + ' new charges (' + r.duplicates + ' were already imported).  ' +
      r.matched + ' matched to submitted receipts.' +
      (r.unknownCards.length ? '  Unknown cards: ' + r.unknownCards.join(', ') + ' (add them on the Cardholders tab, then import again).' : '');
    btn.classList.add('hidden');
  }

  /* =========================================================
   * Signal indicator
   * ========================================================= */
  function updateNet() {
    const n = $('netStatus');
    if (navigator.onLine) { n.textContent = ''; n.className = 'net'; }
    else { n.textContent = 'No service'; n.className = 'net offline'; }
  }

  /* =========================================================
   * Wire up
   * ========================================================= */
  function init() {
    $('btnLogin').addEventListener('click', doLogin);
    $('loginPin').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    $('lnkLogout').addEventListener('click', e => { e.preventDefault(); doLogout(); });
    $('btnGas').addEventListener('click', startGas);
    $('btnPurchase').addEventListener('click', startPurchase);
    $('screenPurchase').addEventListener('click', onReadingClick);
    $('screenPurchase').addEventListener('input', onReadingInput);
    $('screenPurchase').addEventListener('input', onPurchaseInput);
    $('screenPurchase').addEventListener('click', onPurchaseClick);
    $('btnSplit').addEventListener('click', () => setSplit(true));
    $('btnUnsplit').addEventListener('click', () => { pur.parts = []; setSplit(false); });
    $('btnAddPart').addEventListener('click', () => { pur.parts.push({ amount: '', category: '', note: '' }); renderParts(); });
    $('btnPurSubmit').addEventListener('click', submitPurchase);
    ['screenGas', 'screenPurchase'].forEach(id => {
      const clear = () => setMsg($(id === 'screenGas' ? 'gasMsg' : 'purMsg'), '');
      $(id).addEventListener('input', clear);
      $(id).addEventListener('change', clear);
    });
    document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', goHome));

    $('gasCar').addEventListener('change', () => {
      $('gasOtherWrap').classList.toggle('hidden', $('gasCar').value !== OTHER);
    });
    document.querySelectorAll('[data-photo]').forEach(b =>
      b.addEventListener('click', () => takePhoto(b.dataset.photo)));
    $('cameraInput').addEventListener('change', onPhotoChosen);
    $('screenGas').addEventListener('click', onReadingClick);
    $('screenGas').addEventListener('input', onReadingInput);
    $('btnGasSubmit').addEventListener('click', submitGas);
    $('btnAddPump').addEventListener('click', addPump);
    $('btnOpenItems').addEventListener('click', loadOpenItems);
    $('btnOpenRefresh').addEventListener('click', loadOpenItems);
    $('openFilter').addEventListener('change', renderOpenItems);
    $('openWho').addEventListener('input', renderOpenItems);
    $('openList').addEventListener('click', e => { if (e.target.dataset.review) markReviewed(e.target.dataset.review, e.target); });
    $('btnSearch').addEventListener('click', () => { show('screenSearch'); $('sAmount').focus(); });
    $('btnDoSearch').addEventListener('click', doSearch);
    ['sAmount', 'sText', 'sWho'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); }));
    $('btnImport').addEventListener('click', () => {
      $('impFrom').value = new Date().getFullYear() + '-01-01';
      $('impPreview').textContent = ''; $('impResult').textContent = ''; $('impFile').value = '';
      $('btnDoImport').classList.add('hidden');
      show('screenImport');
    });
    $('impFile').addEventListener('change', onImportFile);
    $('impSource').addEventListener('change', onImportFile);
    $('impFrom').addEventListener('change', onImportFile);
    $('btnDoImport').addEventListener('click', doImport);
    $('btnCompliance').addEventListener('click', loadCompliance);
    $('myCompliance').addEventListener('click', onMissingClick);
    $('btnCatchup').addEventListener('click', openCatchup);
    $('btnVehicles').addEventListener('click', loadVehicles);
    $('btnVehRefresh').addEventListener('click', loadVehicles);
    $('vehYear').addEventListener('change', loadVehicles);
    $('cuWho').addEventListener('change', cuLoad);
    $('cuMonth').addEventListener('change', cuLoad);
    $('cuOpenOnly').addEventListener('change', () => { cu.idx = -1; cuNext(1); if (cu.idx < 0) { cu.idx = cu.items.length; cuRender(); } });
    document.querySelectorAll('input[name=cuKind]').forEach(r => r.addEventListener('change', cuKindChanged));
    $('cuCar').addEventListener('change', () => $('cuOtherCar').classList.toggle('hidden', $('cuCar').value !== '__other'));
    $('btnCuPhoto').addEventListener('click', () => takePhoto('catchup'));
    $('btnCuSave').addEventListener('click', cuSave);
    $('btnCuNone').addEventListener('click', cuNone);
    $('btnCuSkip').addEventListener('click', () => { const i = cu.idx; cuNext(1); if (cu.idx === i) { cu.idx = cu.items.length; cuRender(); } });
    $('btnCuPrev').addEventListener('click', () => cuNext(-1));
    ['cuGallons', 'cuMileage', 'cuNote'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') cuSave(); }));
    $('screenGas').addEventListener('click', e => {
      if (e.target.dataset.removePump) removePump(e.target.dataset.removePump);
      if (e.target.dataset.act) setTimeout(updatePumpSum, 0);
    });
    $('screenGas').addEventListener('input', () => setTimeout(updatePumpSum, 0));

    window.addEventListener('online', () => { updateNet(); refreshData(); flushOutbox(); });
    window.addEventListener('offline', updateNet);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) flushOutbox(); });
    setInterval(flushOutbox, 60000);
    updateNet();

    try { $('loginName').value = localStorage.getItem('sfm_last_name') || ''; } catch (e) { /* ignore */ }

    const s = loadSession();
    if (s) { showHome(s); refreshData(); flushOutbox(); } else { showLogin(); }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
