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
                  myCarId: r.myCarId, categories: r.categories };
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
        Object.assign(s, { user: r.user, cars: r.cars, myCarId: r.myCarId, categories: r.categories });
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
    if (!navigator.onLine) {
      $(cur.noService).classList.remove('hidden');
      setManual(fields, '');
      if (kind === 'receipt') renderUnclear();
      return;
    }
    fields.forEach(k => { cur.fields[k] = newField(); cur.fields[k].state = 'reading'; renderReading(k); });
    const s = loadSession();
    let r = null;
    try { r = await api('readPhoto', { token: s && s.token, kind: kind, image: base64 }, 45000); }
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
      const raw = r.fields[k];
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

  function startGas() {
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
    const fieldsFor = { pump: ['total', 'gallons'], odometer: ['odometer'], receipt: ['total'] };
    await readWithAI(kind, fieldsFor[kind], b64);
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
    if (!gas.photos.pump) return setMsg(msg, 'Take a photo of the pump display or receipt.');
    if (!gas.photos.odometer) return setMsg(msg, 'Take a photo of the odometer.');

    const pending = ['total', 'gallons', 'odometer'].filter(k => gas.fields[k].state === 'ai');
    if (pending.length) return setMsg(msg, 'Tap Confirm or Incorrect for each reading.');
    if (['total', 'gallons', 'odometer'].some(k => gas.fields[k].state === 'reading'))
      return setMsg(msg, 'Still reading the photo.  One moment…');

    const total = fieldValue('total'), gallons = fieldValue('gallons'), odometer = fieldValue('odometer');
    if (total == null) return setMsg(msg, 'Enter the sale total.');
    if (gallons == null) return setMsg(msg, 'Enter the gallons.');
    if (odometer == null || Math.round(odometer) !== odometer) return setMsg(msg, 'Enter the odometer in whole miles.');

    const ppg = total / gallons;
    if (ppg < 1.5 || ppg > 10) {
      if (!confirm('That works out to $' + ppg.toFixed(2) + ' per gallon.  Are the total and gallons right?')) return;
    }

    const data = {
      clientId: gas.clientId, capturedAt: gas.capturedAt,
      carId: carId === OTHER ? '' : carId, otherCar: carId === OTHER ? other : '',
      total: total, gallons: gallons, odometer: odometer,
      pumpPhoto: gas.photos.pump, odometerPhoto: gas.photos.odometer,
      ai: { pump: gas.ai.pump, odometer: gas.ai.odometer },
      enteredOffline: !gas.ai.pump || !gas.ai.odometer
    };

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
      $('doneTitle').textContent = 'Sent';
      $('doneText').textContent = 'Thanks!  Your ' + what + ' was submitted.';
    } else {
      $('doneTitle').textContent = 'Saved on your phone';
      $('doneText').textContent = 'No service right now.  Your ' + what + ' is saved and will send automatically when you have signal.  You can close the app.';
    }
    show('screenDone');
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

  function startPurchase() {
    const s = loadSession();
    if (!s) { showLogin(); return; }
    cur = pur = {
      screen: 'screenPurchase', noService: 'purNoService', msg: 'purMsg',
      clientId: uuid(), capturedAt: new Date().toISOString(),
      photos: { receipt: null }, ai: { receipt: null },
      fields: { total: newField() }, unclear: [], itemNotes: {}, split: false, parts: []
    };
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
      ai: { receipt: pur.ai.receipt }, enteredOffline: !pur.ai.receipt
    };
    await saveAndSend('submitPurchase', data, $('btnPurSubmit'), msg, 'purchase receipt');
    pur = null;
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
