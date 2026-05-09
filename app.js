const API_URL = '';
const DB_NAME = 'sendsational-signups';
const STORE_NAME = 'submissions';
let savedNotes = '';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'local_id' });
      store.createIndex('sync_status', 'sync_status');
      store.createIndex('created_at', 'created_at');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putRecord(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllRecords() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getPendingRecords() {
  const all = await getAllRecords();
  return all.filter(r => r.sync_status === 'pending' || r.sync_status === 'failed');
}

async function updateRecord(local_id, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(local_id);
    getReq.onsuccess = () => {
      const current = getReq.result;
      store.put({ ...current, ...patch });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

function digitsOnlyValue(value) {
  return value.replace(/\D/g, '');
}

function formatPhoneValue(value) {
  let digits = value.replace(/\D/g, '');
  const hasLeadingOne = digits.startsWith('1');
  digits = hasLeadingOne ? digits.slice(0, 11) : digits.slice(0, 10);
  let formatted = '';
  if (hasLeadingOne) {
    const rest = digits.slice(1);
    formatted = '1';
    if (rest.length > 0) formatted += ' (' + rest.slice(0, 3);
    if (rest.length >= 4) formatted += ') ' + rest.slice(3, 6);
    if (rest.length >= 7) formatted += '-' + rest.slice(6, 10);
  } else {
    if (digits.length > 0) formatted += '(' + digits.slice(0, 3);
    if (digits.length >= 4) formatted += ') ' + digits.slice(3, 6);
    if (digits.length >= 7) formatted += '-' + digits.slice(6, 10);
  }
  return formatted;
}

function setMessage(text, color = '#222') {
  const el = document.getElementById('message');
  el.textContent = text;
  el.style.color = color;
}

function currentNetworkLabel() {
  return navigator.onLine ? 'Online' : 'Offline';
}

async function refreshUi() {
  document.getElementById('networkStatus').textContent = currentNetworkLabel();
  const pending = await getPendingRecords();
  document.getElementById('pendingCount').textContent = `Pending: ${pending.length}`;

  const all = await getAllRecords();
  const tbody = document.getElementById('queueBody');
  tbody.innerHTML = '';

  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  for (const row of all.slice(0, 50)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(row.created_at).toLocaleString()}</td>
      <td>${row.businessName || ''}</td>
      <td>${row.yourName || ''}</td>
      <td>${row.sync_status || ''}</td>
    `;
    tbody.appendChild(tr);
  }
}

function getFormData(action) {
  return {
    local_id: uuid(),
    created_at: new Date().toISOString(),
    businessName: document.getElementById('businessName').value.trim(),
    yourName: document.getElementById('yourName').value.trim(),
    email: document.getElementById('email').value.trim(),
    phone: document.getElementById('phone').value.trim(),
    locations: document.getElementById('locations').value.trim(),
    zipCode: document.getElementById('zipCode').value.trim(),
    yearsInBusiness: document.getElementById('yearsInBusiness').value.trim(),
    notes: savedNotes,
    action,
    sync_status: 'pending'
  };
}

function clearForm() {
  document.getElementById('businessName').value = '';
  document.getElementById('yourName').value = '';
  document.getElementById('email').value = '';
  document.getElementById('phone').value = '';
  document.getElementById('locations').value = '';
  document.getElementById('zipCode').value = '';
  document.getElementById('yearsInBusiness').value = '';
  document.getElementById('notesText').value = '';
  savedNotes = '';
}

async function queueSubmission(action) {
  const data = getFormData(action);
  await putRecord(data);
  setMessage('Saved locally.', 'green');
  clearForm();
  await refreshUi();
  if (navigator.onLine) {
    await syncPending();
  }
}

async function syncPending() {
  if (!navigator.onLine) {
    setMessage('Offline. Pending records saved locally.', '#cc6600');
    return;
  }

  const pending = await getPendingRecords();
  if (!pending.length) {
    await refreshUi();
    return;
  }

  setMessage('Syncing...', '#222');

  for (const record of pending) {
    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record)
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);

      const json = await resp.json();
      if (!json.ok) throw new Error(json.error || 'Sync failed');

      await updateRecord(record.local_id, {
        sync_status: 'synced',
        synced_at: new Date().toISOString()
      });
    } catch (err) {
      await updateRecord(record.local_id, {
        sync_status: 'failed',
        last_error: String(err)
      });
    }
  }

  document.getElementById('lastSync').textContent = 'Last Sync: ' + new Date().toLocaleString();
  setMessage('Sync complete.', 'green');
  await refreshUi();
}

function bindInputs() {
  document.getElementById('phone').addEventListener('input', e => {
    e.target.value = formatPhoneValue(e.target.value);
  });

  ['locations', 'zipCode', 'yearsInBusiness'].forEach(id => {
    document.getElementById(id).addEventListener('input', e => {
      e.target.value = digitsOnlyValue(e.target.value);
    });
  });
}

function bindButtons() {
  document.getElementById('acceptBtn').addEventListener('click', () => queueSubmission('ACCEPT FREE TRIAL'));
  document.getElementById('enterBtn').addEventListener('click', () => queueSubmission('ENTER'));
  document.getElementById('syncBtn').addEventListener('click', syncPending);

  document.getElementById('notesBtn').addEventListener('click', () => {
    document.getElementById('notesText').value = savedNotes;
    document.getElementById('notesModal').style.display = 'flex';
  });

  document.getElementById('cancelNotesBtn').addEventListener('click', () => {
    document.getElementById('notesModal').style.display = 'none';
  });

  document.getElementById('saveNotesBtn').addEventListener('click', () => {
    savedNotes = document.getElementById('notesText').value.trim();
    document.getElementById('notesModal').style.display = 'none';
  });

  document.getElementById('notesModal').addEventListener('click', e => {
    if (e.target.id === 'notesModal') {
      document.getElementById('notesModal').style.display = 'none';
    }
  });
}

window.addEventListener('online', syncPending);
window.addEventListener('online', refreshUi);
window.addEventListener('offline', refreshUi);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}

bindInputs();
bindButtons();
refreshUi();