import { assignQuestions, normalize, similar } from './message-policy.mjs';

export function installContinuous(ctx) {
  const $ = (id) => document.getElementById(id);
  const panel = document.createElement('section');
  panel.className = 'card';
  panel.id = 'perDevicePanel';
  panel.innerHTML = `<h2>ข้อความแยกแต่ละเครื่อง</h2>
    <p class="muted">ปุ่ม AI สร้างแยกเครื่องใช้สร้างร่างครั้งเดียว ส่วนโหมดต่อเนื่องจะสร้าง เข้าคิว และประมวลผลส่งเข้า LIVE โดยอัตโนมัติ</p>
    <div class="row"><button id="syncDrafts">โหลดเครื่องที่เลือก</button><button id="generateDistinct" class="primary">AI สร้างแยกเครื่อง</button><button id="queueDistinct">นำข้อความแยกเครื่องเข้าคิว</button></div>
    <div id="drafts" style="max-height:360px;overflow:auto;margin-top:12px"></div>
    <p class="muted">พิมพ์ข้อความทดสอบเองในช่องของแต่ละเครื่อง แล้วกดเข้าคิว หรือเลือก “พิมพ์อย่างเดียว” (ตรวจช่องพิมพ์จากหน้าจอจริง ไม่กดส่ง)</p>
    <div class="row"><label for="coordDevice">พิกัดสำหรับเครื่อง</label><select id="coordDevice" style="max-width:280px;padding:10px"></select><button id="saveDeviceCoords">บันทึกพิกัดให้เครื่องนี้</button></div>
    <p id="coordsInfo" class="muted">ส่งจริงตรวจตำแหน่งใหม่แยกแต่ละเครื่องทุกครั้ง · พิกัดที่บันทึกใช้เทียบภาพเท่านั้น</p>
    <hr style="border:0;border-top:1px solid #34455f;margin:20px 0"><h2>ฟังและสร้างคำถามต่อเนื่อง</h2>
    <div class="row"><label for="generationInterval">ตรวจบทพูดใหม่ทุก (วินาที)</label><input id="generationInterval" type="number" min="30" max="600" value="45" style="width:90px"><label for="batchCount">สูงสุดต่อรอบ</label><input id="batchCount" type="number" min="1" max="8" value="3" style="width:65px"></div>
    <div class="row" style="margin-top:12px"><button id="startQuestions">เริ่มอัตโนมัติจากบทพูด</button><button id="listenMic">ฟังไมโครโฟนต่อเนื่อง</button><button id="listenTab">ฟังเสียงแท็บต่อเนื่อง</button><button id="stopContinuous">หยุดทั้งหมด</button></div>
    <p id="autoInfo" class="muted">หยุดอยู่ · โหมดต่อเนื่องเข้าคิวและเริ่มคิวเอง · บทพูดเดิมสร้างประเด็นใหม่ได้จนไม่มีประเด็นเหลือ จากนั้นพัก 5 นาที · มีค่า API ในแต่ละรอบ</p>
    <p class="muted">เว้นระยะส่งจริงรวมอย่างน้อย 30 วินาที และเครื่องเดิม 120 วินาที มีการกรองข้อความคล้ายกัน แต่ไม่รับประกันว่าจะไม่ถูกจำกัดบัญชี</p>`;
  $('questions').closest('section').after(panel);
  let drafts = new Map(),
    assigned = new Map(),
    history = [],
    auto = false,
    epoch = 0,
    generating = false,
    lastTranscript = '',
    autoTimer = null,
    cursor = 0;
  let retryAfter = 0;
  let stream = null,
    media = null,
    chunkTimer = null,
    audioContext = null,
    analyser = null,
    meterTimer = null,
    spoken = false,
    transcribing = false,
    transcriptLog = [];
  let coords = {};
  try {
    coords = JSON.parse(localStorage.getItem('boxphone_coords_v2') || '{}');
  } catch {}
  function ids() {
    return ctx.serials();
  }
  function label(serial) {
    return ctx.label(serial);
  }
  function on(id, fn) {
    $(id).onclick = async () => {
      try {
        await fn();
      } catch (e) {
        ctx.status(e.message, true);
      }
    };
  }
  function info(s) {
    $('autoInfo').textContent = s;
  }
  function render() {
    const target = $('coordDevice').value;
    $('coordDevice').replaceChildren();
    $('drafts').replaceChildren();
    for (const serial of ids()) {
      const opt = document.createElement('option');
      opt.value = serial;
      opt.textContent = label(serial);
      $('coordDevice').append(opt);
      const row = document.createElement('div');
      row.style.cssText = 'border-bottom:1px solid #34455f;padding:12px 0';
      const title = document.createElement('label');
      title.textContent = label(serial);
      title.style.display = 'block';
      const input = document.createElement('textarea');
      input.rows = 2;
      input.maxLength = 500;
      input.placeholder = 'พิมพ์ข้อความเฉพาะเครื่องนี้';
      input.value = drafts.get(serial)?.text || '';
      input.setAttribute('aria-label', 'ข้อความ ' + serial);
      input.oninput = () =>
        drafts.set(serial, { text: input.value, source: 'พิมพ์เอง', at: Date.now(), context: '' });
      const b = document.createElement('button');
      b.textContent = 'พิมพ์อย่างเดียว (ไม่กดส่ง)';
      b.className = 'mini';
      b.onclick = async () => {
        b.disabled = true;
        try {
          if (!ctx.live()) throw new Error('เปิดโหมดส่งจริงก่อนทดสอบพิมพ์บนมือถือ');
          const text = input.value.trim();
          if (!text) throw new Error('กรอกข้อความก่อน');
          const target = ctx.target?.(serial);
          const result = await ctx.api('send', {
            serial,
            text,
            ...getCoords(serial),
            typeOnly: true,
            ...(target ? { targetAccountId: target.accountId, targetKey: target.key } : {}),
          });
          ctx.status(result.detail || 'ยังยืนยันการพิมพ์ไม่ได้', result.delivery !== 'typed');
        } catch (e) {
          ctx.status(e.message, true);
        } finally {
          b.disabled = false;
        }
      };
      row.append(title, input, b);
      $('drafts').append(row);
    }
    if (ids().includes(target)) $('coordDevice').value = target;
    if (!ids().length) $('drafts').textContent = 'เลือกเครื่องด้านซ้าย แล้วกดโหลดเครื่องที่เลือก';
  }
  function getCoords(serial) {
    const c = coords[serial];
    if (c) return { ...c };
    // The bridge resolves each phone from its current UI. Never copy another phone's form coordinates.
    return { chatX: 0, chatY: 0, sendX: 0, sendY: 0 };
  }
  function saveCoords(serial, value) {
    if (!serial) return;
    coords[serial] = value;
    localStorage.setItem('boxphone_coords_v2', JSON.stringify(coords));
  }
  function enqueue() {
    let n = 0;
    const skipped = [];
    for (const serial of ids()) {
      const d = drafts.get(serial);
      if (!d?.text.trim()) continue;
      if (
        d.source !== 'พิมพ์เอง' &&
        (Date.now() - d.at > 120000 || normalize(ctx.transcript()) !== d.context)
      ) {
        skipped.push(label(serial) + ': บริบทเก่า');
        continue;
      }
      try {
        ctx.enqueue(serial, d.text, d.source, d.source === 'พิมพ์เอง' ? Date.now() : d.at);
        n++;
      } catch (e) {
        skipped.push(label(serial) + ': ' + e.message);
      }
    }
    ctx.status(`เพิ่ม ${n} รายการ${skipped.length ? ' · ข้าม ' + skipped.join(' / ') : ''}`);
  }
  async function generate({ automatic = false } = {}) {
    if (generating || transcribing) return;
    const question = ctx.questionConfig();
    const snapshot = ctx.transcript().trim();
    const normalized = normalize(snapshot);
    if (!normalized) {
      if (automatic) {
        info('รอบทพูดใหม่');
        return;
      }
      throw new Error('ใส่บทพูดหรือถอดเสียงก่อน');
    }
    if (automatic && normalized === lastTranscript && Date.now() < retryAfter) {
      info('ยังไม่มีประเด็นใหม่ — พักการสร้าง 5 นาที หรือรอบทพูดเปลี่ยน');
      return;
    }
    const pending = new Set(ctx.pendingSerials());
    const targets = ids()
      .filter((s) => !pending.has(s))
      .sort((a, b) => (assigned.get(a) || 0) - (assigned.get(b) || 0));
    if (!targets.length) {
      info('รอเลือกเครื่อง หรือรอคิวปัจจุบันหมด');
      return;
    }
    const limit = Math.max(1, Math.min(8, Number($('batchCount').value) || 3));
    const chosen = targets.slice(0, limit);
    const run = epoch;
    generating = true;
    $('generateDistinct').disabled = true;
    info('กำลังสร้างคำถามจากบทพูดล่าสุด…');
    try {
      const response = await ctx.api('questions', {
        questionKey: question.key,
        questionProvider: question.provider,
        questionModel: question.model,
        transcript: snapshot,
        style: ctx.style(),
        previous: [...new Set([...ctx.previous(), ...history])].slice(-100),
        count: chosen.length,
      });
      if (run !== epoch || normalize(ctx.transcript()) !== normalized) {
        info('ทิ้งผล AI เพราะหยุดแล้วหรือบทพูดเปลี่ยน');
        return;
      }
      const jobs = assignQuestions(response.questions, chosen, [...history, ...ctx.previous()]);
      lastTranscript = normalized;
      retryAfter = jobs.length ? 0 : Date.now() + 300000;
      for (const job of jobs) {
        if (!ids().includes(job.serial)) continue;
        drafts.set(job.serial, {
          text: job.text,
          source: 'AI',
          at: Date.now(),
          context: normalized,
        });
        assigned.set(job.serial, ++cursor);
        history.push(job.text);
      }
      render();
      if (automatic) {
        for (const job of jobs)
          if (ids().includes(job.serial)) ctx.enqueue(job.serial, job.text, 'AI', Date.now());
      }
      info(
        `AI สร้าง ${jobs.length} ข้อ · ${response.reason || 'ถ้าไม่มีประเด็นใหม่จะพัก 5 นาที'} · ${automatic ? 'เข้าคิวอัตโนมัติแล้ว' : 'ตรวจร่างและนำเข้าคิวเอง'}`,
      );
    } finally {
      generating = false;
      $('generateDistinct').disabled = false;
    }
  }
  function stop() {
    ctx.pause();
    auto = false;
    epoch++;
    clearTimeout(autoTimer);
    autoTimer = null;
    clearTimeout(chunkTimer);
    clearInterval(meterTimer);
    if (media && media.state !== 'inactive') media.stop();
    media = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    audioContext?.close();
    audioContext = null;
    analyser = null;
    $('startQuestions').disabled = false;
    $('listenMic').disabled = false;
    $('listenTab').disabled = false;
    info('หยุดอยู่');
  }
  function startAuto() {
    if (auto) return;
    ctx.stopOther?.();
    ctx.questionConfig();
    if (!ids().length) throw new Error('เลือกเครื่องก่อนเริ่มอัตโนมัติ');
    if (ctx.live()) for (const serial of ids()) getCoords(serial);
    auto = true;
    const run = epoch;
    try {
      ctx.startQueue();
    } catch (e) {
      stop();
      throw e;
    }
    $('startQuestions').disabled = true;
    info('เริ่มโหมดอัตโนมัติแล้ว');
    const loop = async () => {
      if (!auto || run !== epoch) return;
      try {
        await generate({ automatic: true });
      } catch (e) {
        info(e.message);
      }
      if (auto && run === epoch) {
        const sec = Math.max(30, Math.min(600, Number($('generationInterval').value) || 45));
        autoTimer = setTimeout(loop, sec * 1000);
      }
    };
    loop();
  }
  async function segment(run) {
    if (!stream || run !== epoch) return;
    spoken = false;
    const chunks = [];
    media = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: 'audio/webm' });
    media.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    media.onstop = async () => {
      clearTimeout(chunkTimer);
      chunkTimer = null;
      if (run !== epoch) return;
      if (spoken && chunks.length) {
        transcribing = true;
        let received = false,
          failed = false;
        try {
          // Let an in-flight question request finish before using the server AI slot.
          while (generating && run === epoch)
            await new Promise((resolve) => setTimeout(resolve, 100));
          if (run !== epoch) return;
          info('กำลังถอดเสียงช่วงล่าสุด…');
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const reader = new FileReader();
          const base64 = await new Promise((res, rej) => {
            reader.onload = () => res(String(reader.result).split(',')[1]);
            reader.onerror = rej;
            reader.readAsDataURL(blob);
          });
          const r = await ctx.api('transcribe', {
            transcriptionKey: ctx.transcriptionKey(),
            audio: base64,
            name: 'chunk.webm',
            mime: 'audio/webm',
          });
          if (r.text && run === epoch) {
            transcriptLog.push(r.text);
            if (transcriptLog.length > 6) transcriptLog.shift();
            ctx.setTranscript(transcriptLog.join('\n'));
            received = true;
          }
        } catch (e) {
          failed = true;
          info('ถอดเสียง: ' + e.message);
          ctx.status('ถอดเสียง: ' + e.message, true);
        } finally {
          transcribing = false;
        }
        // generate() intentionally refuses to run while transcribing is true.
        // Await it after releasing that flag so errors stay visible and handled.
        if (received && auto && run === epoch) {
          try {
            await generate({ automatic: true });
          } catch (e) {
            info('สร้างคำถาม: ' + e.message);
            ctx.status(e.message, true);
          }
        } else if (!failed && run === epoch && auto) {
          info('ยังไม่ได้บทพูดจากช่วงนี้ — รอฟังช่วงถัดไป');
        }
      } else if (run === epoch) {
        info('ยังไม่พบเสียงพูด — ตรวจว่าเลือกแท็บที่เล่นเสียงและเปิดแชร์เสียงแล้ว');
      }
      if (run === epoch && stream) segment(run);
    };
    media.start();
    chunkTimer = setTimeout(() => {
      if (media && media.state === 'recording') media.stop();
    }, 20000);
  }
  async function listen(kind) {
    ctx.transcriptionKey();
    ctx.questionConfig();
    if (!ids().length) throw new Error('เลือกเครื่องก่อนฟังเสียง');
    stop();
    if (!navigator.mediaDevices) throw new Error('เบราว์เซอร์นี้ไม่รองรับการอัดเสียง');
    stream =
      kind === 'mic'
        ? await navigator.mediaDevices.getUserMedia({ audio: true })
        : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    try {
      if (!stream.getAudioTracks().length)
        throw new Error('ไม่ได้แชร์เสียง กรุณาเลือกแท็บที่มีเสียงและเปิดแชร์เสียง');
      audioContext = new AudioContext();
      await audioContext.resume();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      audioContext
        .createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
        .connect(analyser);
      const levels = new Float32Array(analyser.fftSize);
      meterTimer = setInterval(() => {
        if (!analyser) return;
        analyser.getFloatTimeDomainData(levels);
        const rms = Math.sqrt(levels.reduce((n, v) => n + v * v, 0) / levels.length);
        if (rms > 0.008) spoken = true;
      }, 150);
      stream.getTracks().forEach(
        (t) =>
          (t.onended = () => {
            stop();
            ctx.pause();
          }),
      );
      transcriptLog = [];
      ctx.setTranscript('');
      startAuto();
      $('listenMic').disabled = true;
      $('listenTab').disabled = true;
      segment(epoch);
      info('กำลังฟังครั้งละ 20 วินาที · สร้างคำถามและเข้าคิวอัตโนมัติตามโหมดที่เลือก');
    } catch (e) {
      stop();
      throw e;
    }
  }
  on('syncDrafts', render);
  on('generateDistinct', () => generate());
  on('queueDistinct', enqueue);
  on('startQuestions', startAuto);
  on('listenMic', () => listen('mic'));
  on('listenTab', () => listen('tab'));
  on('stopContinuous', stop);
  on('saveDeviceCoords', () => {
    const serial = $('coordDevice').value;
    if (!serial) throw new Error('เลือกเครื่องก่อน');
    const value = Object.fromEntries(
      ['chatX', 'chatY', 'sendX', 'sendY'].map((k) => [k, Number($(k).value)]),
    );
    if (Object.values(value).some((v) => !Number.isFinite(v) || v <= 0))
      throw new Error('ตั้งพิกัดทั้งช่องพิมพ์และปุ่มส่งก่อน');
    coords[serial] = value;
    localStorage.setItem('boxphone_coords_v2', JSON.stringify(coords));
    $('coordsInfo').textContent = 'บันทึกพิกัดแล้ว: ' + label(serial);
  });
  $('coordDevice').onchange = () => {
    const c = coords[$('coordDevice').value];
    $('coordsInfo').textContent = c ? 'มีพิกัดที่บันทึกไว้' : 'เครื่องนี้ยังไม่มีพิกัด';
    if (c) for (const [k, v] of Object.entries(c)) $(k).value = v;
  };
  window.addEventListener('beforeunload', stop);
  return {
    render,
    generate,
    stop,
    getCoords,
    saveCoords,
    active: () => auto,
    isAudioActive: () => !!stream,
  };
}
