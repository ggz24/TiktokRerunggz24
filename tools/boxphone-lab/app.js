import { installContinuous } from './continuous.mjs';
import { similar, waitForSend } from './message-policy.mjs';
import { installLivehub } from './livehub.mjs';
import { installCredentials } from './credentials.mjs';
const $ = (id) => document.getElementById(id);
let token = document.querySelector('meta[name="lab-token"]').content;
const apiRoot = document.querySelector('meta[name="lab-api-root"]')?.content || '/api';
let devices = [],
  selected = new Set(),
  queue = [],
  questions = [],
  history = [],
  timer = null,
  audioBlob = null,
  audioName = '',
  audioURL = '',
  recorder = null,
  capture = null,
  recordingTimer = null;
let resultSource = '',
  resultAt = 0;
const liveMode = true; // Real sending only; queues still require an explicit Start.
let pickTarget = 'chat'; // 'chat' or 'send' for coordinate picker
let lab = null,
  routing = null,
  queueRunning = false,
  queueEpoch = 0,
  tickBusy = false,
  lastGlobal = 0,
  lastByDevice = new Map();
let credentials = null;
function stopAutomation() {
  lab?.stop();
  routing?.stop();
}
const isPending = (x) => x.state === 'รอส่งจริง';
function enqueueOne(serial, text, source, at = Date.now(), explicitTarget) {
  text = String(text).trim();
  if (!text || text.length > 500) throw new Error('ข้อความต้องมี 1–500 ตัวอักษร');
  if (!selected.has(serial)) throw new Error('เครื่องนี้ไม่ได้ถูกเลือก');
  if (queue.filter(isPending).length >= 100) throw new Error('คิวรอเต็ม 100 รายการ');
  if (queue.some((x) => isPending(x) && x.serial === serial))
    throw new Error('เครื่องนี้มีงานรออยู่แล้ว');
  const target = explicitTarget || routing?.target(serial);
  if (
    queue.some(
      (x) =>
        x.target?.accountId === target?.accountId &&
        Date.now() - Date.parse(x.createdAt) < 600000 &&
        similar(x.text, text),
    )
  )
    throw new Error('ข้อความซ้ำหรือคล้ายในช่องนี้ใน 10 นาทีที่ผ่านมา');
  const coordinates = lab.getCoords(serial);
  queue.push({
    serial,
    text,
    source,
    coordinates,
    ...(target ? { target: { ...target } } : {}),
    createdAt: new Date().toISOString(),
    expiresAt: at + 120000,
    state: 'รอส่งจริง',
    mode: 'live',
  });
  if (queue.length > 500)
    queue = queue
      .filter((x) => isPending(x) || Date.now() - Date.parse(x.createdAt) < 600000)
      .slice(-500);
  renderQueue();
}

function status(text, error = false) {
  $('status').textContent = text;
  $('status').className = error ? 'error' : 'live-active';
}
async function api(path, data = {}, retried = false) {
  let r;
  try {
    r = await fetch(apiRoot + '/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lab-Token': token },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(path === 'devices' ? 35000 : 120000),
    });
  } catch {
    throw new Error(
      'ติดต่อ Boxphone Lab ไม่ได้หรือรอนานเกินไป — เปิด Start.cmd แล้วกดค้นหาเครื่องอีกครั้ง',
    );
  }
  // Retry only device discovery; never replay a send.
  if (r.status === 403 && path === 'devices' && !retried) {
    const page = await fetch(apiRoot === '/api' ? '/' : apiRoot + '/view', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
    const current = doc.querySelector('meta[name="lab-token"]')?.content;
    if (current) {
      token = current;
      return api(path, data, true);
    }
  }
  const v = await r.json();
  if (!r.ok) throw new Error(v.error || 'เกิดข้อผิดพลาด');
  return v;
}
function bind(id, fn) {
  $(id).addEventListener('click', async () => {
    try {
      await fn();
    } catch (e) {
      status(e.message, true);
    }
  });
}
async function busy(ids, fn) {
  ids.forEach((id) => ($(id).disabled = true));
  try {
    return await fn();
  } finally {
    ids.forEach((id) => ($(id).disabled = false));
  }
}
function requireTranscriptionKey() {
  return credentials.transcriptionKey();
}
function questionConfig() {
  return credentials.questionConfig();
}
async function updateQuestionProvider() {
  try {
    await credentials.changeProvider();
  } catch (e) {
    status(e.message, true);
  }
}

// Real sending is the only mode. Opening the page does not start the queue.
function updateModeUI() {
  $('modeBadge').textContent = 'ส่งเข้า TikTok LIVE';
  $('modeBadge').className = 'badge live';
  $('tiktokSettings').style.display = '';
  $('statusHint').textContent = 'ตรวจห้องของแต่ละเครื่องก่อนส่ง · กดเริ่มเพื่อส่งข้อความในคิว';
  $('topNotice').className = 'notice';
  $('topNotice').textContent =
    'เลือกโทรศัพท์และช่อง LIVE ตรวจห้องที่เปิดอยู่ แล้วกดเริ่มส่งหรือเริ่มถามอัตโนมัติ';
  $('queueTitle').textContent = '3. คิวส่งข้อความ';
  $('queueDesc').textContent = 'ข้อความในคิวส่งเข้า TikTok LIVE เมื่อกดเริ่ม งานหมดอายุใน 2 นาที';
  $('run').textContent = 'เริ่มส่งข้อความ';
  $('run').className = 'primary';
  renderQuestions();
}

// --- Device Tagging & Numbering ---
function getDeviceTags() {
  try {
    return JSON.parse(localStorage.getItem(tagStorageKey) || '{}');
  } catch {
    return {};
  }
}
const tagStorageKey =
  'boxphone_names:' + (document.querySelector('meta[name="lab-owner"]')?.content || 'local');
function setDeviceTag(serial, tag) {
  const tags = getDeviceTags();
  if (tag) tags[serial] = String(tag).trim();
  else delete tags[serial];
  localStorage.setItem(tagStorageKey, JSON.stringify(tags));
}
function getDeviceTag(serial, index) {
  const d = devices.find((phone) => phone.serial === serial);
  return d?.xiaoweiNumber != null
    ? String(d.xiaoweiNumber)
    : getDeviceTags()[serial] || serial.slice(-6);
}
let inspectedSerial = '',
  screenBusy = false;
async function inspectPhone(serial) {
  if (screenBusy) return;
  const d = devices.find((phone) => phone.serial === serial);
  if (!d || d.state !== 'device') throw Error('เครื่องไม่พร้อมใช้งาน');
  inspectedSerial = serial;
  $('screenTitle').textContent =
    d.xiaoweiNumber != null
      ? `เครื่อง #${d.xiaoweiNumber} ใน Xiaowei`
      : 'เครื่องที่ยังไม่มีหมายเลข Xiaowei';
  $('screenIdentity').textContent = `${d.xiaoweiName || d.model} · ${d.serial}`;
  $('deviceNickname').value = getDeviceTags()[serial] || '';
  $('screen').removeAttribute('src');
  $('screenTime').textContent = 'กำลังอ่านภาพหน้าจอ…';
  if (!$('screenDialog').open) $('screenDialog').showModal();
  await refreshPhoneScreen();
}
async function refreshPhoneScreen() {
  if (screenBusy || !inspectedSerial) return;
  screenBusy = true;
  $('refreshScreen').disabled = true;
  try {
    const serial = inspectedSerial;
    const r = await api('screenshot', { serial });
    if (serial === inspectedSerial) {
      $('screen').src = r.image;
      $('screenTime').textContent = 'ภาพล่าสุด ' + new Date().toLocaleTimeString('th-TH');
    }
    status('อ่านภาพหน้าจอแล้ว เทียบหมายเลขกับ Xiaowei ได้เลย');
  } catch (e) {
    $('screenTime').textContent = e.message;
    throw e;
  } finally {
    screenBusy = false;
    $('refreshScreen').disabled = false;
  }
}

// --- Device rendering ---
function renderDevices() {
  $('count').textContent = devices.filter((d) => d.state === 'device').length;
  $('devices').replaceChildren();
  const query = $('deviceSearch').value.trim().toLowerCase(),
    tags = getDeviceTags();
  const visible = devices.filter((d) =>
    [
      d.xiaoweiNumber != null ? '#' + d.xiaoweiNumber : '',
      d.xiaoweiName,
      d.model,
      d.serial,
      tags[d.serial],
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query),
  );
  $('deviceMatch').textContent =
    `แสดง ${visible.length} / ${devices.length} เครื่อง · เลือก ${selected.size} เครื่อง`;
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.textContent = query ? 'ไม่พบเครื่องที่ตรงกับคำค้น' : 'ยังไม่พบโทรศัพท์';
    $('devices').append(empty);
  }
  visible.forEach((d, index) => {
    const row = document.createElement('div');
    row.className = 'device';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(d.serial);
    check.disabled = d.state !== 'device';
    check.setAttribute('aria-label', 'เลือก ' + d.serial);
    check.onchange = () => {
      check.checked ? selected.add(d.serial) : selected.delete(d.serial);
      $('deviceMatch').textContent =
        `แสดง ${visible.length} / ${devices.length} เครื่อง · เลือก ${selected.size} เครื่อง`;
      lab?.render();
      routing?.render();
    };

    const tagBadge = document.createElement('span');
    tagBadge.className = 'device-num';
    const tagVal = getDeviceTag(d.serial, index);
    tagBadge.textContent = d.xiaoweiNumber != null ? `#${d.xiaoweiNumber}` : '—';
    tagBadge.title =
      d.xiaoweiNumber != null ? 'หมายเลขเดียวกับ Xiaowei' : 'ยังอ่านหมายเลข Xiaowei ไม่ได้';

    const label = document.createElement('label');
    label.append(tagBadge, document.createTextNode(tags[d.serial] || d.xiaoweiName || d.model));
    const sub = document.createElement('small');
    sub.textContent = d.model + ' · ' + (d.state === 'device' ? 'เชื่อมต่อแล้ว' : d.state);
    label.append(sub);
    const serialLabel = document.createElement('small');
    serialLabel.textContent = d.serial;
    label.append(serialLabel);
    label.onclick = () => check.click();

    const btn = document.createElement('button');
    btn.className = 'mini';
    btn.textContent = 'หาเครื่อง';
    btn.setAttribute(
      'aria-label',
      `หาเครื่อง ${d.xiaoweiNumber != null ? '#' + d.xiaoweiNumber : d.serial}`,
    );
    btn.disabled = d.state !== 'device';
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await inspectPhone(d.serial);
      } catch (e) {
        status(e.message, true);
      } finally {
        btn.disabled = d.state !== 'device';
      }
    };
    row.append(check, label, btn);
    $('devices').append(row);
  });
  lab?.render();
  routing?.render();
}
let _autoRefreshTimer = null;
let refreshing = false,
  deviceConnectionFailed = false;
async function refresh(quiet = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const r = await api('devices');
    const changed = JSON.stringify(devices) !== JSON.stringify(r.devices);
    devices = r.devices;
    selected = new Set(
      [...selected].filter((s) => devices.some((d) => d.serial === s && d.state === 'device')),
    );
    if (changed || !quiet || deviceConnectionFailed) renderDevices();
    const count = devices.filter((d) => d.state === 'device').length;
    if (count > 0) {
      if (changed || !quiet || deviceConnectionFailed) status(`พบ ${count} เครื่องพร้อมใช้งาน`);
    } else {
      status('ไม่พบเครื่อง — กำลังรอการเชื่อมต่อ ADB… (ตรวจสอบ USB/Xiaowei)');
    }
    deviceConnectionFailed = false;
  } catch (e) {
    deviceConnectionFailed = true;
    $('count').textContent = '—';
    stopAutomation();
    throw e;
  } finally {
    refreshing = false;
  }
}
function stopAutoRefresh() {
  if (_autoRefreshTimer) {
    clearInterval(_autoRefreshTimer);
    _autoRefreshTimer = null;
  }
}
function startAutoRefresh() {
  stopAutoRefresh();
  refresh().catch((e) => status(e.message, true));
  _autoRefreshTimer = setInterval(() => {
    refresh(true).catch((e) => status(e.message, true));
  }, 5000);
}

// --- Questions rendering (mode-aware) ---
function renderQuestions() {
  $('questions').replaceChildren();
  for (const q of questions) {
    const row = document.createElement('div');
    row.className = 'question';
    const text = document.createElement('span');
    text.textContent = q;
    const btn = document.createElement('button');
    btn.textContent = 'เข้าคิวส่งจริง';
    btn.className = 'primary';
    btn.onclick = () => {
      try {
        if (Date.now() - resultAt > 120000)
          throw new Error('ผลลัพธ์เกิน 2 นาทีแล้ว กรุณาสร้างใหม่');
        if (!selected.size) throw new Error('เลือกเครื่องด้านซ้ายก่อน');
        const serial = [...selected].find(
          (s) => !queue.some((x) => isPending(x) && x.serial === s),
        );
        if (!serial) throw new Error('ทุกเครื่องมีงานรอแล้ว');
        enqueueOne(serial, q, resultSource, resultAt);
        status(
          'เพิ่มข้อความให้เครื่องเดียว: ' +
            serial +
            ' · ใช้ส่วนข้อความแยกเครื่องเพื่อกำหนดแต่ละเครื่อง',
        );
      } catch (e) {
        status(e.message, true);
      }
    };
    row.append(text, btn);
    $('questions').append(row);
  }
}

// --- Queue rendering ---
function renderQueue() {
  $('queue').replaceChildren();
  for (const item of queue) {
    const tr = document.createElement('tr');
    if (item.state.includes('ไม่สำเร็จ')) tr.style.color = '#ff7b9a';
    else if (item.state.includes('สำเร็จ')) tr.style.color = '#78e0c5';
    else if (item.state === 'กำลังส่ง…') tr.style.color = '#f0d9a8';
    const devTag = getDeviceTag(item.serial);
    const devLabel = devTag ? `[#${devTag}] ${item.serial}` : item.serial;
    for (const t of [devLabel, ...(routing ? [routing.label(item)] : []), item.text, item.state]) {
      const td = document.createElement('td');
      td.textContent = t;
      tr.append(td);
    }
    $('queue').append(tr);
    for (const [stage, image] of Object.entries(item.evidence || {}))
      if (image) {
        const button = document.createElement('button');
        button.className = 'mini';
        button.textContent = stage === 'before' ? 'ภาพก่อนกดส่ง' : 'ภาพหลังตรวจผล';
        button.onclick = () => {
          $('screen').src = image;
          $('screenTitle').textContent = button.textContent + ' · ' + devLabel;
          $('screenDialog').showModal();
        };
        tr.lastChild.append(button);
      }
  }
}

// --- Queue execution ---
function pause() {
  queueRunning = false;
  queueEpoch++;
  clearTimeout(timer);
  timer = null;
  $('run').disabled = false;
}

async function tick() {
  if (!queueRunning || tickBusy) return;
  const run = queueEpoch;
  for (const item of queue)
    if (item.state === 'รอส่งจริง' && Date.now() > item.expiresAt) item.state = 'หมดอายุ';
  const pendingState = 'รอส่งจริง';
  const next = queue.find((x) => x.state === pendingState);
  if (!next) {
    renderQueue();
    if (lab?.active() || routing?.active()) {
      timer = setTimeout(tick, 1000);
      return;
    }
    pause();
    status('จบคิวแล้ว');
    return;
  }
  if (!selected.has(next.serial)) {
    next.state = 'ยกเลิก: ไม่ได้เลือกเครื่อง';
    renderQueue();
    timer = setTimeout(tick, 100);
    return;
  }
  if (routing && !routing.validJob(next)) {
    next.state = 'ยกเลิก: ช่องปลายทางเปลี่ยนหรือหยุดไลฟ์';
    renderQueue();
    timer = setTimeout(tick, 100);
    return;
  }
  {
    const wait = waitForSend(Date.now(), lastGlobal, lastByDevice.get(next.serial) || 0);
    if (wait) {
      status(`เว้นช่วงอีก ${Math.ceil(wait / 1000)} วินาที`);
      timer = setTimeout(tick, Math.min(wait, 1000));
      return;
    }
  }
  tickBusy = true;

  {
    // Real TikTok Live send
    next.state = 'กำลังตรวจข้อความ / ส่ง / ตรวจผล…';
    renderQueue();
    try {
      const sent = await api('send', {
        serial: next.serial,
        text: next.text,
        ...next.coordinates,
        ...(next.target
          ? { targetAccountId: next.target.accountId, targetKey: next.target.key }
          : {}),
      });
      if (sent.attempted) {
        lastGlobal = Date.now();
        lastByDevice.set(next.serial, lastGlobal);
      }
      next.delivery = sent.delivery;
      next.evidence = sent.evidence;
      next.state = sent.detail || 'ยังยืนยันผลไม่ได้';
      next.completedAt = new Date().toISOString();
      if (sent.delivery !== 'observed_local') {
        pause();
        stopAutomation();
        selected.delete(next.serial);
        renderDevices();
        status(
          next.state + ' · พักคิวและยกเลิกการเลือกเครื่องนี้ ตรวจภาพหลักฐานก่อนเลือกเครื่องกลับ',
          true,
        );
      } else if (run === queueEpoch) status(next.state + ': ' + next.serial);
    } catch (e) {
      next.state = 'ขัดข้อง — ยังยืนยันการส่งไม่ได้: ' + e.message;
      next.completedAt = new Date().toISOString();
      status('ส่งไม่สำเร็จ: ' + e.message, true);
      pause();
      stopAutomation();
    }
  }
  renderQueue();
  tickBusy = false;
  if (queueRunning && run === queueEpoch) {
    const gap = Math.max(30, Math.min(300, Number($('interval').value) || 30));
    timer = setTimeout(tick, gap * 1000);
  }
}

// --- ADBKeyBoard controls ---
bind('checkKb', async () => {
  if (!selected.size) throw new Error('เลือกเครื่องก่อน');
  const serial = [...selected][0];
  status('กำลังตรวจสอบ ADBKeyBoard...');
  const r = await api('check-keyboard', { serial });
  if (!r.installed) {
    $('kbStatus').textContent = '❌ ยังไม่ได้ติดตั้ง ADBKeyBoard';
    $('kbStatus').style.color = '#ff7b9a';
    status('ADBKeyBoard ยังไม่ได้ติดตั้ง — ต้องติดตั้ง APK ก่อน', true);
  } else if (!r.active) {
    $('kbStatus').textContent = '⚠️ ติดตั้งแล้ว แต่ยังไม่ได้ตั้งเป็น keyboard หลัก';
    $('kbStatus').style.color = '#f0d9a8';
    status('ADBKeyBoard ติดตั้งแล้ว กด "ตั้งเป็น keyboard หลัก" เพื่อเปิดใช้');
  } else {
    $('kbStatus').textContent = '✅ พร้อมใช้งาน';
    $('kbStatus').style.color = '#78e0c5';
    status('ADBKeyBoard พร้อมใช้งานแล้ว');
  }
});

bind('setupKb', async () => {
  if (!selected.size) throw new Error('เลือกเครื่องก่อน');
  const serial = [...selected][0];
  status('กำลังตั้ง ADBKeyBoard...');
  await api('setup-keyboard', { serial });
  $('kbStatus').textContent = '✅ ตั้งเป็น keyboard หลักแล้ว';
  $('kbStatus').style.color = '#78e0c5';
  status('ตั้ง ADBKeyBoard เป็น keyboard หลักสำเร็จ');
});

// --- Quick test send (no queue) ---
bind('testSend', async () => {
  if (!selected.size) throw new Error('เลือกเครื่องก่อน');
  const text = $('testMsg').value.trim();
  if (!text) throw new Error('กรอกข้อความก่อน');
  const chatX = Number($('chatX').value) || 0;
  const chatY = Number($('chatY').value) || 0;
  const sendX = Number($('sendX').value) || 0;
  const sendY = Number($('sendY').value) || 0;
  const serial = singlePhone();
  const res = $('testResult');
  res.textContent = 'กำลังส่ง…';
  res.style.color = '#f0d9a8';
  console.log(
    `[testSend] serial=${serial} text="${text}" chat(${chatX},${chatY}) send(${sendX},${sendY})`,
  );
  status(`กำลังส่ง: "${text}" → เครื่อง #${getDeviceTag(serial)}`);
  try {
    const target = routing?.target(serial);
    const sent = await api('send', {
      serial,
      text,
      chatX,
      chatY,
      sendX,
      sendY,
      ...(target ? { targetAccountId: target.accountId, targetKey: target.key } : {}),
    });
    lastGlobal = Date.now();
    lastByDevice.set(serial, lastGlobal);
    if (sent.chat) {
      $('chatX').value = sent.chat.x;
      $('chatY').value = sent.chat.y;
    }
    if (sent.send?.x) {
      $('sendX').value = sent.send.x;
      $('sendY').value = sent.send.y;
    }
    res.textContent = sent.detail || 'ยังยืนยันผลไม่ได้';
    res.style.color = sent.delivery === 'observed_local' ? '#78e0c5' : '#f0d9a8';
    for (const [stage, image] of Object.entries(sent.evidence || {}))
      if (image) {
        const button = document.createElement('button');
        button.textContent = stage === 'before' ? 'ภาพก่อนกดส่ง' : 'ภาพหลังตรวจผล';
        button.className = 'mini';
        button.onclick = () => {
          $('screen').src = image;
          $('screenTitle').textContent = button.textContent;
          $('screenDialog').showModal();
        };
        res.append(button);
      }
    if (sent.delivery !== 'observed_local') {
      pause();
      stopAutomation();
      selected.delete(serial);
      renderDevices();
    }
    status(res.firstChild?.textContent || sent.detail, sent.delivery !== 'observed_local');
  } catch (e) {
    console.error('[testSend] error:', e);
    res.textContent = `ขัดข้อง — ยังยืนยันการส่งไม่ได้: ${e.message}`;
    res.style.color = '#ff7b9a';
    status('ส่งไม่สำเร็จ: ' + e.message, true);
  }
});

function singlePhone() {
  if (selected.size !== 1)
    throw Error('เลือกโทรศัพท์เพียงหนึ่งเครื่องเพื่อตรวจตำแหน่งหรือส่งข้อความจากหน้านี้');
  return [...selected][0];
}
function showLocation(serial, r) {
  for (const [name, point] of [
    ['chat', r.chat],
    ['send', r.send],
  ]) {
    $(name + 'X').value = point?.x ?? '';
    $(name + 'Y').value = point?.y ?? '';
  }
  const detail =
    'เครื่อง #' +
    getDeviceTag(serial) +
    ' · ตรวจตำแหน่งจากหน้าจอจริงตรงกันสองครั้ง' +
    (r.chat.focused ? ' · ช่องพิมพ์โฟกัสแล้ว' : ' · ก่อนส่งจะเปิดช่องพิมพ์และตรวจซ้ำ') +
    (r.send ? ' · พบปุ่มส่ง' : ' · จะตรวจปุ่มส่งอีกครั้งหลังพิมพ์ข้อความ');
  $('detectResult').textContent = detail;
  $('detectResult').style.color = '#78e0c5';
  status(detail);
}
bind('detectChat', async () => {
  const serial = singlePhone();
  await busy(['detectChat', 'prepareChat'], async () => {
    status('กำลังตรวจช่องแชทสองครั้งจากหน้าจอจริง…');
    try {
      showLocation(serial, await api('detect-chat', { serial }));
    } catch (e) {
      for (const id of ['chatX', 'chatY', 'sendX', 'sendY']) $(id).value = '';
      $('detectResult').textContent = e.message;
      $('detectResult').style.color = '#ff7b9a';
      throw e;
    }
  });
});
bind('prepareChat', async () => {
  const serial = singlePhone();
  await busy(['detectChat', 'prepareChat'], async () => {
    status('กำลังเปิดและตรวจช่องพิมพ์ ไม่พิมพ์และไม่ส่งข้อความ…');
    const r = await api('prepare-chat', { serial });
    showLocation(serial, r);
    $('composerTitle').textContent = 'เครื่อง #' + getDeviceTag(serial) + ' · ช่องพิมพ์ที่ตรวจพบ';
    $('composerInfo').textContent =
      r.detail + ' · ' + new Date(r.checkedAt).toLocaleTimeString('th-TH');
    $('composerImage').src = r.image;
    for (const [id, point] of [
      ['composerChatBox', r.chat],
      ['composerSendBox', r.send],
    ]) {
      const box = $(id),
        b = point?.bounds;
      box.hidden = !b;
      if (b) {
        box.style.left = (b.x1 / r.width) * 100 + '%';
        box.style.top = (b.y1 / r.height) * 100 + '%';
        box.style.width = ((b.x2 - b.x1) / r.width) * 100 + '%';
        box.style.height = ((b.y2 - b.y1) / r.height) * 100 + '%';
      }
    }
    $('composerDialog').showModal();
  });
});
bind('closeComposerDialog', () => $('composerDialog').close());

// --- Coordinate picker from screenshot ---
let pickSerial = '';
bind('pickCoords', async () => {
  pickSerial = singlePhone();
  status('กำลังอ่านภาพหน้าจอสำหรับจับพิกัด...');
  const r = await api('screenshot', { serial: pickSerial });
  $('pickImg').src = r.image;
  pickTarget = 'chat';
  $('pickChatBtn').className = 'mini primary';
  $('pickSendBtn').className = 'mini';
  $('pickDialog').showModal();
  status('คลิกบนภาพเพื่อจับพิกัดช่องแชท');
});

bind('pickChatBtn', () => {
  pickTarget = 'chat';
  $('pickChatBtn').className = 'mini primary';
  $('pickSendBtn').className = 'mini';
  status('คลิกบนภาพเพื่อจับพิกัดช่องแชท');
});
bind('pickSendBtn', () => {
  pickTarget = 'send';
  $('pickSendBtn').className = 'mini primary';
  $('pickChatBtn').className = 'mini';
  status('คลิกบนภาพเพื่อจับพิกัดปุ่มส่ง');
});
bind('closePickDialog', () => $('pickDialog').close());

$('pickImg').addEventListener('click', async (e) => {
  const img = $('pickImg');
  const rect = img.getBoundingClientRect();
  // Calculate actual device coordinates from click position
  // We need the actual screen size for proper mapping
  const clickXRatio = (e.clientX - rect.left) / rect.width;
  const clickYRatio = (e.clientY - rect.top) / rect.height;

  try {
    const sizeResult = await api('screen-size', { serial: pickSerial });
    const devX = Math.round(clickXRatio * sizeResult.width);
    const devY = Math.round(clickYRatio * sizeResult.height);

    if (pickTarget === 'chat') {
      $('chatX').value = devX;
      $('chatY').value = devY;
      status(`ตั้งพิกัดช่องแชท: (${devX}, ${devY}) — กดเลือก "ปุ่มส่ง" แล้วคลิกบนภาพอีกครั้ง`);
      // Auto-switch to send
      pickTarget = 'send';
      $('pickSendBtn').className = 'mini primary';
      $('pickChatBtn').className = 'mini';
    } else {
      $('sendX').value = devX;
      $('sendY').value = devY;
      // Auto-save coordinates for this device
      const coordsValue = {
        chatX: Number($('chatX').value),
        chatY: Number($('chatY').value),
        sendX: devX,
        sendY: devY,
      };
      if (lab?.saveCoords) lab.saveCoords(pickSerial, coordsValue);
      console.log('[pickCoords] บันทึกพิกัดให้เครื่อง', pickSerial, coordsValue);
      status(`ตั้งพิกัดปุ่มส่ง: (${devX}, ${devY}) — จับพิกัดเสร็จและบันทึกแล้ว`);
      $('pickDialog').close();
    }
  } catch (err) {
    console.error('[pickCoords] error:', err);
    status('ไม่สามารถอ่านขนาดหน้าจอ: ' + err.message, true);
  }
});

// --- Existing bindings ---
function setAudio(blob, name) {
  audioBlob = blob;
  audioName = name;
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = URL.createObjectURL(blob);
  $('audioPreview').src = audioURL;
  $('audioPreview').hidden = false;
  status('เสียงพร้อมแล้ว: ' + name + ' — กดถอดเสียงเมื่อต้องการส่งไป AI');
}
async function record(kind) {
  if (lab?.isAudioActive()) throw new Error('หยุดฟังต่อเนื่องก่อนอัดเสียงแยก');
  if (recorder) throw new Error('กำลังอัดเสียงอยู่');
  if (!navigator.mediaDevices)
    throw new Error('เบราว์เซอร์นี้ไม่รองรับการอัดเสียง ใช้ Chrome/Edge หรืออัปโหลดไฟล์');
  capture =
    kind === 'mic'
      ? await navigator.mediaDevices.getUserMedia({ audio: true })
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const tracks = capture.getAudioTracks();
  if (!tracks.length) {
    capture.getTracks().forEach((t) => t.stop());
    capture = null;
    throw new Error('ไม่ได้รับเสียง กรุณาเลือกแท็บที่มีเสียงและเปิดแชร์เสียง');
  }
  const chunks = [];
  try {
    recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: 'audio/webm' });
  } catch {
    capture.getTracks().forEach((t) => t.stop());
    capture = null;
    throw new Error('เบราว์เซอร์ไม่รองรับรูปแบบการอัดนี้ กรุณาใช้ไฟล์เสียงแทน');
  }
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => {
    clearTimeout(recordingTimer);
    capture?.getTracks().forEach((t) => t.stop());
    capture = null;
    recorder = null;
    $('recordMic').disabled = false;
    $('recordTab').disabled = false;
    $('stopRecord').disabled = true;
    $('recordInfo').textContent = 'อัดเสร็จแล้ว สามารถฟังก่อนส่งถอดเสียงได้';
    setAudio(new Blob(chunks, { type: 'audio/webm' }), 'recording.webm');
  };
  recorder.onerror = () => {
    status('การอัดเสียงล้มเหลว กรุณาใช้ไฟล์เสียงแทน', true);
    stopRecording();
  };
  capture.getTracks().forEach((t) => (t.onended = stopRecording));
  recorder.start();
  $('recordMic').disabled = true;
  $('recordTab').disabled = true;
  $('stopRecord').disabled = false;
  $('recordInfo').textContent = 'กำลังอัดเสียง… หยุดอัตโนมัติใน 60 วินาที';
  status('กำลังอัดเสียงในเครื่อง ยังไม่ส่งไป AI');
  recordingTimer = setTimeout(stopRecording, 60000);
}
function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}
bind('refresh', () => busy(['refresh'], refresh));
bind('selectAll', () => {
  const ready = devices.filter((d) => d.state === 'device');
  selected = selected.size === ready.length ? new Set() : new Set(ready.map((d) => d.serial));
  renderDevices();
});
bind('renumber', () => {
  $('deviceSearch').value = '';
  renderDevices();
});
bind('refreshScreen', refreshPhoneScreen);
bind('saveDeviceNickname', () => {
  if (!inspectedSerial) return;
  setDeviceTag(inspectedSerial, $('deviceNickname').value.slice(0, 60));
  renderDevices();
  renderQueue();
  status('บันทึกชื่อเครื่องในเว็บแล้ว');
});
$('deviceSearch').addEventListener('input', renderDevices);
bind('forgetKey', () => credentials.forget());
bind('closeScreen', () => $('screenDialog').close());

function addCustomQuestion() {
  const input = $('customQuestion');
  const text = input.value.trim();
  if (!text) return;
  if (!questions.includes(text)) {
    questions.push(text);
  }
  resultAt = Date.now();
  resultSource = 'พิมพ์เอง';
  $('source').textContent = 'ข้อความที่พิมพ์เอง';
  renderQuestions();
  input.value = '';
  status(`เพิ่มคำถาม "${text}" แล้ว สามารถกด "${'เข้าคิวส่งจริง'}" ได้เลย`);
}
bind('addCustomQuestion', addCustomQuestion);
$('customQuestion').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addCustomQuestion();
});

bind('sample', () => {
  $('transcript').value =
    'วันนี้เราจะทำขนมโดยใช้แป้งข้าวเจ้า ถ้าเปลี่ยนชนิดแป้งเนื้อขนมจะต่างกัน ส่วนผสมที่เตรียมไว้มีแป้ง น้ำตาล และกะทิ';
  questions = [];
  renderQuestions();
  $('source').textContent = 'ใส่ข้อความตัวอย่างแล้ว';
  status('ใส่บทพูดตัวอย่างแล้ว');
});
bind('demo', () => {
  questions = [
    'ถ้าใช้แป้งสาลีแทน เนื้อขนมจะเปลี่ยนยังไงครับ?',
    'ส่วนผสมแต่ละอย่างใช้ปริมาณเท่าไรครับ?',
  ];
  resultAt = Date.now();
  resultSource = 'ตัวอย่างตายตัว ไม่ใช่ AI';
  $('source').textContent = 'ตัวอย่างตายตัวสำหรับบทพูดทำขนม ไม่ได้วิเคราะห์ข้อความที่คุณป้อน';
  renderQuestions();
  status('แสดงตัวอย่างคำถามแล้ว (ไม่ได้เรียก AI)');
});
bind('generate', () => busy(['generate', 'transcribe'], () => lab.generate()));
$('audioFile').onchange = () => {
  const f = $('audioFile').files[0];
  if (f) setAudio(f, f.name);
};
bind('transcribe', () =>
  busy(['generate', 'transcribe'], async () => {
    const transcriptionKey = requireTranscriptionKey();
    if (!audioBlob) throw new Error('เลือกไฟล์หรืออัดเสียงก่อน');
    if (audioBlob.size > 24 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 24 MB');
    status('กำลังส่งเสียงไปถอดข้อความ…');
    const audio = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(audioBlob);
    });
    const r = await api('transcribe', {
      transcriptionKey,
      audio,
      name: audioName,
      mime: audioBlob.type,
    });
    $('transcript').value = r.text;
    questions = [];
    renderQuestions();
    $('source').textContent = 'กรุณาสร้างคำถามจากบทพูดใหม่';
    status('ถอดเสียงสำเร็จ ตรวจข้อความแล้วกดสร้างคำถามได้');
  }),
);
bind('recordMic', () => record('mic'));
bind('recordTab', () => record('tab'));
bind('stopRecord', stopRecording);
function startQueue() {
  if (queueRunning) return;
  const pendingState = 'รอส่งจริง';
  if (!queue.some((x) => x.state === pendingState) && !lab.active() && !routing?.active())
    throw new Error('ยังไม่มีคิว เปิด AI ต่อเนื่องหรือเพิ่มข้อความก่อน');
  if (liveMode) {
    if (!routing?.active()) for (const serial of selected) lab.getCoords(serial);
  }
  queueRunning = true;
  queueEpoch++;
  $('run').disabled = true;
  status('กำลังประมวลผลคิวส่งจริง');
  if (tickBusy) timer = setTimeout(tick, 1000);
  else tick();
}
bind('run', startQueue);
bind('pause', () => {
  pause();
  stopAutomation();
  status('หยุดคิวและ AI แล้ว · คำสั่งที่ส่งไปมือถือก่อนกดหยุดอาจยังจบงาน');
});
bind('clearQueue', () => {
  pause();
  stopAutomation();
  queue = [];
  renderQueue();
  status('ล้างคิวแล้ว');
});
bind('export', () => {
  const blob = new Blob(
    [JSON.stringify({ mode: 'live', exportedAt: new Date().toISOString(), queue }, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'boxphone-lab-results.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('beforeunload', () => {
  capture?.getTracks().forEach((t) => t.stop());
  pause();
});
$('transcript').addEventListener('input', () => {
  questions = [];
  resultAt = 0;
  for (const item of queue)
    if (item.source === 'AI' && isPending(item)) item.state = 'ยกเลิก: บทพูดเปลี่ยน';
  renderQueue();
  renderQuestions();
  $('source').textContent = 'บทพูดเปลี่ยนแล้ว กรุณาสร้างคำถามใหม่';
});
$('questionProvider').addEventListener('change', updateQuestionProvider);
credentials = installCredentials({ api, status, stop: stopAutomation });
lab = installContinuous({
  api,
  status,
  startQueue,
  transcriptionKey: requireTranscriptionKey,
  questionConfig,
  live: () => liveMode,
  serials: () =>
    devices.filter((d) => d.state === 'device' && selected.has(d.serial)).map((d) => d.serial),
  label: (s) =>
    `#${getDeviceTag(
      s,
      devices.findIndex((d) => d.serial === s),
    )} · ${s}`,
  transcript: () => $('transcript').value,
  style: () => $('style').value,
  setTranscript: (text) => {
    $('transcript').value = text;
    // New audio extends the conversation; it must not cancel queued messages.
    // An explicit empty transcript starts a fresh listening session.
    if (!text.trim())
      for (const item of queue)
        if (item.source === 'AI' && isPending(item)) item.state = 'ยกเลิก: เริ่มฟังรอบใหม่';
    renderQueue();
  },
  previous: () => queue.map((x) => x.text),
  pendingSerials: () => queue.filter(isPending).map((x) => x.serial),
  enqueue: enqueueOne,
  pause,
  target: (serial) => routing?.target(serial),
  stopOther: () => routing?.stop(),
});
routing = installLivehub({
  api,
  apiRoot,
  status,
  live: () => liveMode,
  serials: () =>
    devices.filter((d) => d.state === 'device' && selected.has(d.serial)).map((d) => d.serial),
  label: (s) =>
    `#${getDeviceTag(
      s,
      devices.findIndex((d) => d.serial === s),
    )} · ${s}`,
  saveCoords: (s, c) => lab.saveCoords(s, c),
  questionConfig,
  transcriptionKey: requireTranscriptionKey,
  style: () => $('style').value,
  previous: (id) => queue.filter((x) => x.target?.accountId === id).map((x) => x.text),
  pendingSerials: () => queue.filter(isPending).map((x) => x.serial),
  enqueue: enqueueOne,
  startQueue,
  pause,
  renderQueue,
  stopOther: () => {
    lab.stop();
    stopRecording();
  },
  cancel: (serial, reason) => {
    for (const job of queue)
      if (isPending(job) && job.serial === serial) job.state = 'ยกเลิก: ' + reason;
  },
  invalidateTranscript: () => {
    $('transcript').value = '';
    questions = [];
    renderQuestions();
  },
  setTranscript: (text) => {
    $('transcript').value = text;
    questions = [];
    renderQuestions();
    $('source').textContent = 'ถอดเสียงจากคลังแล้ว สร้างคำถามจากบทพูดได้';
  },
});
updateModeUI();
startAutoRefresh();
