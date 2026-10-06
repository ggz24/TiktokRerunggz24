import { groupDevices, bindingMatches } from './target-policy.mjs';
import { assignQuestions } from './message-policy.mjs';
import {
  chunkStarts,
  defaultQuestionCount,
  formatClock,
  planDue,
  planFromText,
  planToText,
} from './plan.mjs';

/** Library and per-phone routing are only enabled inside the authenticated Live Hub frame. */
export function installLivehub(ctx) {
  const meta = document.querySelector('meta[name="lab-livehub-root"]');
  if (!meta) return null;
  const root = meta.content,
    $ = (id) => document.getElementById(id);
  const key = 'boxphone_targets_v1:' + document.querySelector('meta[name="lab-owner"]').content;
  let assignments = {};
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) assignments = stored;
  } catch {
    /* Discard damaged local preferences. */
  }
  let channels = [],
    videos = [],
    targets = new Map(),
    auto = false,
    epoch = 0,
    timer = null;
  let working = false,
    catalogBusy = false,
    catalogTimer = null,
    nextDevice = new Map(),
    lastContent = new Map(),
    nextChannel = '';
  const info = (text) => {
    $('channelAutoInfo').textContent = text;
  };
  const on = (id, fn) => {
    $(id).onclick = async () => {
      try {
        await fn();
      } catch (e) {
        ctx.status(e.message, true);
      }
    };
  };
  const label = (id) => {
    const c = channels.find((c) => c.id === id);
    return c ? `${c.alias} · @${c.handle}` : 'ไม่ได้กำหนดช่อง';
  };
  const channelFor = (serial) => channels.find((c) => c.id === assignments[serial]);
  function selectedTarget(serial) {
    const channel = channelFor(serial);
    if (!channel) throw new Error('เลือกช่องให้ ' + ctx.label(serial) + ' ก่อน');
    const target = targets.get(channel.id);
    if (!target || channel.status !== 'live')
      throw new Error('กดเปิด LIVE ของ ' + ctx.label(serial) + ' ก่อนเข้าคิวส่งจริง');
    return { ...target };
  }
  function validJob(job) {
    const channel = channelFor(job.serial);
    return (
      bindingMatches(job, channel?.id, job.mode === 'live' ? targets.get(channel?.id) : null) &&
      (job.mode !== 'live' || (channel?.status === 'live' && targets.has(channel.id)))
    );
  }
  function renderRoutes() {
    $('deviceTargets').replaceChildren();
    for (const serial of ctx.serials()) {
      const row = document.createElement('div');
      row.className = 'device-target';
      const name = document.createElement('strong');
      name.textContent = ctx.label(serial);
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'ช่อง LIVE สำหรับ ' + ctx.label(serial));
      const none = new Option('— เลือกช่อง LIVE —', '');
      select.add(none);
      for (const c of channels)
        select.add(
          new Option(
            `${c.alias} · @${c.handle || 'ยังไม่ยืนยัน'}${c.status === 'live' ? ' · กำลังส่งสตรีม' : ' · ยังไม่ไลฟ์'}`,
            c.id,
          ),
        );
      select.value = assignments[serial] || '';
      select.onchange = () => {
        stop();
        assignments[serial] = select.value;
        localStorage.setItem(key, JSON.stringify(assignments));
        ctx.cancel(serial, 'เปลี่ยนช่องปลายทาง');
        targets.clear();
        lastContent.clear();
        renderRoutes();
        ctx.renderQueue();
      };
      const detail = document.createElement('p');
      detail.className = 'muted';
      const c = channelFor(serial);
      const aiState = !c
        ? ''
        : !c.aiEnabled
          ? 'ยังไม่ได้เปิด'
          : c.aiReady && c.chatReady
            ? 'เปิดและเชื่อมแชทแล้ว'
            : !c.aiReady
              ? 'เปิดแล้ว แต่ยังไม่มีคีย์หรือข้อมูลสินค้า (ตั้งค่า AI ตอบแชท)'
              : 'เปิดแล้ว แต่ยังไม่เชื่อมแชท (ตรวจว่าช่องกำลังไลฟ์ และวาง cURL แชทในหน้าตั้งค่า AI)';
      detail.textContent = c
        ? `คลิปที่ช่องนี้ไลฟ์: ${c.videoName || 'ยังไม่ได้เลือกวิดีโอ'} · AI ตอบ: ${aiState}`
        : 'กำหนดช่องแยกเครื่องได้ หลายเครื่องเลือกช่องเดียวกันได้ แต่ละช่องใช้แผนคำถามของคลิปที่ช่องนั้นไลฟ์เอง';
      const plan = c?.videoId ? store.get(planKey(c.videoId)) : null;
      const planLine = document.createElement('p');
      planLine.className = 'muted';
      planLine.textContent = !c
        ? ''
        : !c.videoId
          ? 'แผนคำถาม: ช่องนี้ยังไม่ได้เลือกคลิป'
          : plan
            ? `แผนคำถามของคลิปนี้: พร้อม ${plan.items.length} ข้อ`
            : 'แผนคำถามของคลิปนี้: ยังไม่มี (กดเริ่มถามอัตโนมัติ ระบบจะให้ AI ฟังคลิปให้เอง หรือกดปุ่มด้านล่างเพื่อทำก่อน)';
      const listen = document.createElement('button');
      listen.type = 'button';
      listen.className = 'mini';
      listen.textContent = 'ให้ AI ฟังคลิปนี้และวางแผนคำถาม';
      listen.hidden = !c?.videoId || !!plan;
      listen.onclick = async () => {
        listen.disabled = true;
        try {
          await buildPlanFor(c.videoId);
        } catch (e) {
          ctx.status(e.message, true);
        } finally {
          listen.disabled = false;
        }
      };
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mini';
      button.textContent = 'เปิด LIVE บนเครื่องนี้';
      button.disabled = !c?.connected || c?.status !== 'live';
      button.onclick = async () => {
        button.disabled = true;
        try {
          await openPhone(serial);
          ctx.status('ตรวจพบช่องเป้าหมายแล้ว: ' + ctx.label(serial));
        } catch (e) {
          ctx.status(e.message, true);
        } finally {
          button.disabled = !c?.connected || c?.status !== 'live';
        }
      };
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'mini';
      check.textContent = 'ตรวจห้องที่เปิดอยู่';
      check.disabled = !c?.connected || c?.status !== 'live';
      check.onclick = async () => {
        check.disabled = true;
        try {
          await openPhone(serial, undefined, undefined, true);
          ctx.status('ยืนยันช่องของ ' + ctx.label(serial) + ' แล้ว');
        } catch (e) {
          ctx.status(e.message, true);
        } finally {
          check.disabled = !c?.connected || c?.status !== 'live';
        }
      };
      const settings = document.createElement('a');
      settings.href = root + '/comments';
      settings.target = '_top';
      settings.textContent = 'ตั้งค่า AI ตอบแชท';
      settings.className = 'muted';
      row.append(name, select, detail, planLine, listen, button, check, settings);
      $('deviceTargets').append(row);
    }
    if (!ctx.serials().length) $('deviceTargets').textContent = 'เลือกโทรศัพท์จากรายการอุปกรณ์ก่อน';
  }
  async function refreshCatalog() {
    if (catalogBusy) return;
    catalogBusy = true;
    try {
      const r = await fetch(ctx.apiRoot + '/catalog', {
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'โหลดคลังและช่องไม่สำเร็จ');
      const changed = JSON.stringify(channels) !== JSON.stringify(data.channels);
      for (const c of data.channels) {
        const old = channels.find((x) => x.id === c.id);
        if (
          old &&
          (old.startedAt !== c.startedAt || old.videoId !== c.videoId || c.status !== 'live')
        ) {
          targets.delete(c.id);
          lastContent.delete(c.id);
          for (const serial of ctx.serials())
            if (assignments[serial] === c.id) ctx.cancel(serial, 'ช่องหยุดหรือเริ่มไลฟ์ใหม่');
        }
      }
      for (const c of channels)
        if (!data.channels.some((n) => n.id === c.id)) {
          targets.delete(c.id);
          for (const serial of ctx.serials())
            if (assignments[serial] === c.id) ctx.cancel(serial, 'ช่องถูกลบ');
        }
      channels = data.channels;
      if (JSON.stringify(videos) !== JSON.stringify(data.videos)) {
        const previous = $('libraryVideo').value;
        videos = data.videos;
        $('libraryVideo').replaceChildren(new Option('— เลือกวิดีโอจากคลัง —', ''));
        for (const v of videos)
          $('libraryVideo').add(
            new Option(v.name + (v.status === 'ready' ? '' : ' · ยังไม่พร้อม'), v.id),
          );
        for (const option of $('libraryVideo').options)
          if (videos.find((v) => v.id === option.value)?.status !== 'ready' && option.value)
            option.disabled = true;
        if (videos.some((v) => v.id === previous)) $('libraryVideo').value = previous;
      }
      if (changed) renderRoutes();
      ctx.renderQueue();
    } catch (e) {
      // Fail closed: stale catalogue must not keep driving phones after losing the control service.
      if (auto) stop();
      targets.clear();
      info('ตรวจช่องไม่ได้: ' + e.message);
      throw e;
    } finally {
      catalogBusy = false;
    }
  }
  async function openPhone(serial, expected, run, currentOnly = false) {
    if (!ctx.live()) throw new Error('เปิดโหมดส่งจริงก่อนสั่งโทรศัพท์เข้าห้อง LIVE');
    const channel = channelFor(serial);
    if (!channel?.connected || channel.status !== 'live')
      throw new Error('ช่องของเครื่องนี้ยังไม่ส่งสตรีม');
    const result = await ctx.api(currentOnly ? 'check-live' : 'open-live', {
      serial,
      targetAccountId: channel.id,
      ...(expected ? { targetKey: expected.key } : {}),
    });
    if (run !== undefined && run !== epoch) throw new Error('ยกเลิกการเปิดช่องแล้ว');
    if (assignments[serial] !== channel.id) throw new Error('เปลี่ยนช่องระหว่างเปิด LIVE แล้ว');
    if (!result.verified) throw new Error(result.detail + ' · ดูจอเครื่อง ' + ctx.label(serial));
    targets.set(channel.id, result.target);
    const coords = await ctx.api('detect-chat', { serial });
    if (run !== undefined && run !== epoch) throw new Error('หยุดงานแล้ว');
    ctx.saveCoords(serial, {
      chatX: coords.chat.x,
      chatY: coords.chat.y,
      sendX: coords.send?.x || 0,
      sendY: coords.send?.y || 0,
    });
    return result.target;
  }
  // --- Whole-clip question plans: listen to a library video once, then ask by playback position. ---
  const owner = document.querySelector('meta[name="lab-owner"]').content;
  const store = {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(k) || 'null');
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      } catch {
        return false;
      }
    },
  };
  const planKey = (id) => `boxphone_plan_v1:${owner}:${id}`,
    textKey = (id) => `boxphone_transcript_v1:${owner}:${id}`,
    useKey = `boxphone_plan_use_v1:${owner}`;
  const usePlan = () => !!$('planUse')?.checked;
  const usedPlans = new Map();
  let planBusy = false,
    planStop = false;
  const planInfo = (text) => {
    $('planInfo').textContent = text;
    if (planBusy) info(text);
  };
  function showPlan(plan) {
    $('planEditor').value = plan ? planToText(plan.items) : '';
    planInfo(
      plan
        ? `${plan.videoName || 'คลิป'} · ยาว ${formatClock(plan.duration)} · ${plan.items.length} คำถาม · วางแผนโดย ${plan.model} · ปรับแก้ได้ แล้วกดบันทึก`
        : 'ยังไม่มีแผนของคลิปนี้',
    );
  }
  /** Transcribe every 60s window once. Finished windows are kept, so a stopped run resumes without paying again. */
  async function listenToClip(videoId) {
    const saved = store.get(textKey(videoId)) || {};
    let duration = saved.duration || null,
      name = saved.name || '';
    const chunks = Array.isArray(saved.chunks) ? saved.chunks : [];
    const have = new Map(chunks.map((c) => [c.start, c.text]));
    let starts = duration ? chunkStarts(duration) : [0];
    for (let i = 0; i < starts.length; i++) {
      if (planStop) throw new Error('หยุดแล้ว เก็บส่วนที่ฟังแล้วไว้ กดอีกครั้งเพื่อทำต่อจากเดิม');
      const start = starts[i];
      if (have.has(start)) continue;
      const seconds = duration ? Math.min(60, Math.floor(duration - start)) : 60;
      let result = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try {
          result = await ctx.api('transcribe-video', {
            videoId,
            startSeconds: start,
            seconds,
            transcriptionKey: ctx.transcriptionKey(),
          });
        } catch (e) {
          // A window with no sound is not an error; anything else is retried once and then stops the run.
          if (/อ่านเสียงไม่ได้/.test(e.message) && duration) {
            result = { text: '', silent: true };
            break;
          }
          if (attempt) throw e;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (!duration) {
        duration = result.durationSeconds;
        name = result.videoName || '';
        starts = chunkStarts(duration);
      }
      have.set(start, String(result.text || ''));
      store.set(textKey(videoId), {
        duration,
        name,
        chunks: [...have].map(([s, text]) => ({ start: s, text })),
      });
      planInfo(
        `กำลังให้ AI ฟังคลิป ${have.size}/${starts.length} ช่วง (ช่วงละ 1 นาที) · หยุดได้ ทำต่อจากเดิมได้`,
      );
    }
    return { duration, name, chunks: [...have].map(([start, text]) => ({ start, text })) };
  }
  const buildPlan = () => {
    const id = $('libraryVideo').value;
    if (!id) throw new Error('เลือกวิดีโอจากคลังก่อน');
    return buildPlanFor(id);
  };
  async function buildPlanFor(videoId) {
    if (planBusy) throw new Error('กำลังฟังคลิปอยู่');
    const q = ctx.questionConfig();
    if (q.provider !== 'openai')
      throw new Error('แผนคำถามทั้งคลิปใช้ OpenAI — เลือกผู้ให้บริการสร้างคำถามเป็น OpenAI');
    stop();
    ctx.stopOther();
    planBusy = true;
    planStop = false;
    $('planBuild').disabled = true;
    try {
      ctx.status('กำลังให้ AI ฟังทั้งคลิป…');
      const heard = await listenToClip(videoId);
      planInfo('ฟังครบแล้ว กำลังให้ AI วางแผนคำถามจากบทพูดทั้งหมด…');
      const result = await ctx.api('plan-questions', {
        questionKey: q.key,
        planModel: $('planModel').value.trim(),
        fallbackModel: q.model,
        chunks: heard.chunks,
        duration: heard.duration,
        count: Number($('planCount').value) || defaultQuestionCount(heard.duration),
        minGap: Number($('planGap').value) || 120,
        style: ctx.style(),
        previous: [],
      });
      const plan = {
        videoId,
        videoName: heard.name,
        duration: heard.duration,
        model: result.model,
        createdAt: new Date().toISOString(),
        items: result.items,
      };
      if (!plan.items.length) throw new Error(result.reason || 'AI ไม่พบประเด็นที่ควรถาม');
      store.set(planKey(videoId), plan);
      if ($('libraryVideo').value === videoId) showPlan(plan);
      ctx.status(
        `วางแผนคำถามของ ${plan.videoName || 'คลิป'} แล้ว ${plan.items.length} ข้อ ตรวจและแก้ไขได้ในช่องแผนคำถามของส่วนคลังวิดีโอ`,
      );
    } catch (e) {
      planInfo(e.message);
      throw e;
    } finally {
      planBusy = false;
      $('planBuild').disabled = false;
      renderRoutes();
    }
  }
  async function planCycle(channel, chosen, cursor, run) {
    const plan = channel.videoId ? store.get(planKey(channel.videoId)) : null;
    if (!plan?.items?.length) {
      info(
        label(channel.id) +
          ': ยังไม่มีแผนคำถามของคลิป ' +
          (channel.videoName || '') +
          ' — เลือกคลิปนี้แล้วกด "ให้ AI ฟังทั้งคลิป" ก่อน',
      );
      return;
    }
    const key = channel.id + ':' + channel.startedAt;
    const used = usedPlans.get(key) || new Set();
    usedPlans.set(key, used);
    const { position, due, stale } = planDue(
      plan.items,
      { startedAt: channel.startedAt, now: Date.now(), duration: plan.duration },
      used,
    );
    for (const item of stale) used.add(item.id); // too old to ask now
    if (position === null) {
      info(label(channel.id) + ': รอคลิปเริ่มเล่น');
      return;
    }
    if (!due.length) {
      const next = plan.items.find((i) => i.at > position);
      info(
        `${label(channel.id)} · คลิปเล่นถึง ~${formatClock(position)} · ${next ? 'คำถามถัดไปที่ ' + formatClock(next.at) : 'ไม่มีคำถามเหลือในรอบคลิปนี้'} · ไม่เรียก AI`,
      );
      return;
    }
    const jobs = assignQuestions(
      due.map((d) => d.text),
      chosen,
      ctx.previous(channel.id),
    );
    const asked = new Set(jobs.map((j) => j.text));
    for (const item of due.slice(0, chosen.length)) if (!asked.has(item.text)) used.add(item.id); // a duplicate of something already asked
    for (const job of jobs) {
      if (!auto || run !== epoch) return;
      if (assignments[job.serial] !== channel.id || !ctx.serials().includes(job.serial)) continue;
      let target;
      try {
        target = await openPhone(job.serial, undefined, run);
      } catch (e) {
        ctx.status(e.message, true);
        stop();
        throw e;
      }
      if (!auto || run !== epoch) return;
      ctx.enqueue(job.serial, job.text, 'แผนคำถาม @' + channel.handle, Date.now(), target);
      used.add(due.find((d) => d.text === job.text).id);
    }
    nextDevice.set(channel.id, cursor + jobs.length);
    ctx.startQueue();
    info(
      `${label(channel.id)} · คลิปเล่นถึง ~${formatClock(position)} · ส่งคำถามจากแผน ${jobs.length} ข้อ · ไม่เรียก AI`,
    );
  }
  function stop() {
    auto = false;
    epoch++;
    clearTimeout(timer);
    timer = null;
    ctx.pause();
    $('startChannelAuto').disabled = false;
    info('หยุดอยู่');
  }
  async function cycle(run) {
    if (!auto || run !== epoch || working) return;
    working = true;
    try {
      await refreshCatalog();
      if (!auto || run !== epoch) return;
      const rawGroups = groupDevices(ctx.serials(), assignments, channels);
      const first = Math.max(
        0,
        rawGroups.findIndex((g) => g.channel.id === nextChannel),
      );
      const groups = rawGroups.slice(first).concat(rawGroups.slice(0, first));
      if (!groups.length) {
        info('รอช่องที่กำหนดเริ่มส่งสตรีม LIVE');
        return;
      }
      for (const [groupIndex, { channel, serials }] of groups.entries()) {
        if (!auto || run !== epoch) return;
        if (!channel.aiEnabled || !channel.aiReady || !channel.chatReady) {
          info('รอเปิดและเชื่อม AI ตอบแชทของ ' + label(channel.id));
          continue;
        }
        const pending = new Set(ctx.pendingSerials());
        // At a 30s global send gap, reserve only slots that can be sent before the 2 minute expiry.
        const slots = Math.max(0, 3 - pending.size);
        if (!slots) break;
        nextChannel = groups[(groupIndex + 1) % groups.length].channel.id;
        const eligible = serials.filter((s) => !pending.has(s));
        const cursor = nextDevice.get(channel.id) || 0;
        const rotated = eligible
          .slice(cursor % Math.max(1, eligible.length))
          .concat(eligible.slice(0, cursor % Math.max(1, eligible.length)));
        const chosen = rotated.slice(
          0,
          Math.min(slots, Math.max(1, Math.min(8, Number($('channelBatch').value) || 1))),
        );
        if (!chosen.length) continue;
        if (usePlan()) {
          try {
            await planCycle(channel, chosen, cursor, run);
          } catch (e) {
            if (!auto || run !== epoch) return;
            info(label(channel.id) + ': ' + e.message);
            ctx.status(e.message, true);
          }
          continue;
        }
        try {
          info('อ่านบทพูดของ ' + label(channel.id) + ' จากวิดีโอที่กำลังเล่น…');
          const segment = await ctx.api('channel-transcript', {
            accountId: channel.id,
            seconds: 30,
            transcriptionKey: ctx.transcriptionKey(),
          });
          if (!auto || run !== epoch) return;
          if (!segment.text?.trim()) continue;
          const old = lastContent.get(channel.id);
          if (old?.text === segment.text && old.at > Date.now() - 300000) continue;
          targets.set(channel.id, segment.target);
          const q = ctx.questionConfig();
          const result = await ctx.api('questions', {
            questionKey: q.key,
            questionProvider: q.provider,
            questionModel: q.model,
            transcript: segment.text,
            style: ctx.style(),
            previous: ctx.previous(channel.id),
            count: chosen.length,
          });
          if (!auto || run !== epoch) return;
          lastContent.set(channel.id, { text: segment.text, at: Date.now() });
          const jobs = assignQuestions(result.questions, chosen, ctx.previous(channel.id));
          for (const job of jobs) {
            if (!auto || run !== epoch) return;
            if (assignments[job.serial] !== channel.id || !ctx.serials().includes(job.serial))
              continue;
            if (ctx.live())
              try {
                await openPhone(job.serial, segment.target, run);
              } catch (e) {
                ctx.status(e.message, true);
                stop();
                throw e;
              }
            if (!auto || run !== epoch) return;
            ctx.enqueue(
              job.serial,
              job.text,
              'AI ช่อง ' + channel.handle,
              Date.now(),
              segment.target,
            );
          }
          nextDevice.set(channel.id, cursor + jobs.length);
          ctx.startQueue();
          info(
            `${label(channel.id)} · ช่วง ${Math.floor(segment.startSeconds)} วินาที · เพิ่ม ${jobs.length} คำถาม · ส่งผ่านโทรศัพท์`,
          );
        } catch (e) {
          if (!auto || run !== epoch) return;
          info(label(channel.id) + ': ' + e.message);
          ctx.status(e.message, true);
        }
      }
    } finally {
      working = false;
      if (auto && run === epoch)
        timer = setTimeout(
          () => cycle(run),
          Math.max(45, Math.min(600, Number($('channelInterval').value) || 120)) * 1000,
        );
    }
  }
  async function start() {
    if (working) throw new Error('รอรอบก่อนหน้าจบก่อนเริ่มใหม่');
    // A saved plan needs no per-round transcription or question generation, so no AI key is required to run it.
    ctx.stopOther();
    if (!usePlan()) {
      ctx.questionConfig();
      ctx.transcriptionKey();
    }
    await refreshCatalog();
    if (!ctx.serials().length || ctx.serials().some((s) => !channelFor(s)))
      throw new Error('เลือกโทรศัพท์และกำหนดช่องให้ทุกเครื่องก่อน');
    if (usePlan()) {
      // Each channel plays its own clip, so every clip in use needs its own plan; listen to the missing ones first.
      const missing = [
        ...new Set(
          ctx
            .serials()
            .map((s) => channelFor(s))
            .filter((c) => c.status === 'live' && c.videoId && !store.get(planKey(c.videoId)))
            .map((c) => c.videoId),
        ),
      ];
      if (missing.length) {
        $('startChannelAuto').disabled = true;
        try {
          for (const id of missing) await buildPlanFor(id);
        } finally {
          $('startChannelAuto').disabled = false;
        }
      }
    }
    lastContent.clear();
    auto = true;
    epoch++;
    $('startChannelAuto').disabled = true;
    info('เริ่มอัตโนมัติตามช่องแล้ว');
    try {
      ctx.startQueue();
      void cycle(epoch);
    } catch (e) {
      stop();
      throw e;
    }
  }
  function sourceChanged() {
    const library = $('audioSource').value === 'library';
    $('librarySource').hidden = !library;
    $('localSource').hidden = library;
    stop();
    ctx.invalidateTranscript();
    $('libraryPreview').pause();
  }
  const source = document.createElement('div');
  source.className = 'library-source';
  source.innerHTML = `
    <label class="field" for="audioSource">แหล่งเสียง / วิดีโอ</label><select id="audioSource"><option value="library">วิดีโอจากคลัง Live Hub</option><option value="file">เลือกไฟล์จากเครื่อง / อัดเสียง</option></select>
    <div id="librarySource"><div class="row"><select id="libraryVideo" aria-label="วิดีโอจากคลัง"><option value="">กำลังโหลดคลัง…</option></select><button id="refreshLibrary">รีเฟรชคลังและช่อง</button></div>
    <div class="row"><label for="libraryStart">เริ่มที่ (วินาที)</label><input id="libraryStart" type="number" min="0" value="0"><label for="librarySeconds">ความยาว (วินาที)</label><input id="librarySeconds" type="number" min="5" max="60" value="30"><button id="libraryTranscribe" class="primary">ถอดเสียงจากคลัง</button></div>
    <p class="muted">เลือกช่วงเสียงครั้งละ 5–60 วินาทีได้โดยไม่ต้องดาวน์โหลดวิดีโอทั้งไฟล์ โหมดถามตามช่องด้านล่างจะเลือกวิดีโอและช่วงเวลาจากสตรีมของช่องเอง</p><video id="libraryPreview" controls preload="none" hidden></video>
    <h3 style="margin:18px 0 6px">วางแผนคำถามทั้งคลิป (ประหยัดกว่าถามซ้ำ)</h3>
    <p class="muted">ให้ AI ฟังคลิปที่เลือกทั้งหมดครั้งเดียว แล้ววางแผนคำถามตามช่วงเวลาของคลิป ตอนไลฟ์ระบบส่งคำถามตามตำแหน่งที่คลิปเล่นอยู่ โดยไม่ถอดเสียงและไม่เรียก AI สร้างคำถามซ้ำ ผลที่ฟังแล้วเก็บไว้ในเบราว์เซอร์นี้ ฟังซ้ำไม่เสียค่าใช้จ่าย</p>
    <div class="row"><label for="planCount">จำนวนคำถาม</label><input id="planCount" type="number" min="1" max="60" placeholder="อัตโนมัติ"><label for="planGap">ห่างกันอย่างน้อย (วินาที)</label><input id="planGap" type="number" min="30" max="1800" value="120"></div>
    <div class="row"><label for="planModel">โมเดลวางแผน (OpenAI)</label><input id="planModel" type="text" autocomplete="off" value="gpt-4.1-mini" style="flex:1"></div>
    <div class="row"><button id="planBuild" class="primary">ให้ AI ฟังทั้งคลิปแล้ววางแผนคำถาม</button><button id="planStop">หยุดฟัง</button></div>
    <p id="planInfo" class="muted">ยังไม่มีแผนของคลิปนี้</p>
    <label class="field" for="planEditor">แผนคำถาม (เวลาในคลิป | คำถาม หนึ่งบรรทัดต่อหนึ่งข้อ)</label>
    <textarea id="planEditor" rows="8" placeholder="0:45 | ในกล่องมีกี่ซองคะ"></textarea>
    <div class="row"><button id="planSave">บันทึกการแก้ไขแผน</button><button id="planClear">ลบแผนของคลิปนี้</button></div>
    <label class="row" style="gap:8px"><input id="planUse" type="checkbox"> ถามตามแผนของคลิป (แนะนำ · ประหยัด) · ถ้าไม่ติ๊ก ระบบจะอ่านบทพูดสดทุกรอบและเรียก AI บ่อย</label></div>`;
  const file = $('audioFile').closest('.row'),
    fileNote = file.nextElementSibling;
  const local = document.createElement('div');
  local.id = 'localSource';
  file.before(source, local);
  local.append(file, fileNote); // Keep the original upload/audio workflow in its own source section.
  for (const id of ['recordMic', 'recordInfo', 'audioPreview']) {
    const el = $(id);
    const move = id === 'recordMic' ? el.closest('.row') : el;
    if (move) local.append(move);
  }
  local.hidden = true;
  const panel = document.createElement('section');
  panel.className = 'card';
  panel.id = 'livehubRouting';
  panel.innerHTML = `
    <h2>โทรศัพท์ → ช่อง LIVE</h2>
    <ol class="muted" style="margin:6px 0 12px 18px;line-height:1.7"><li><b>เลือกโทรศัพท์</b> ที่เปิด TikTok อยู่ในห้องไลฟ์ (ติ๊กในรายการอุปกรณ์ด้านบน)</li><li><b>เลือกช่อง LIVE</b> ให้แต่ละเครื่องในรายการนี้ — เครื่องที่ดูไลฟ์ช่องเดียวกันเลือกช่องเดียวกัน เครื่องที่ดูอีกช่อง (คลิปอื่น) เลือกอีกช่อง ระบบใช้แผนคำถามของคลิปที่ช่องนั้นไลฟ์อยู่ให้เอง</li><li>กด <b>เริ่มถามอัตโนมัติตามช่อง</b> เพียงปุ่มเดียว ระบบให้ AI ฟังคลิปที่ยังไม่มีแผน ตรวจห้อง แล้วเข้าคิวและส่งตามเวลาให้เอง ไม่ต้องกดส่งเข้าคิวเอง</li></ol>
    <div id="deviceTargets"></div>
    <h2 style="margin-top:20px">ถามอัตโนมัติตามช่องที่ไลฟ์</h2><div class="row"><label for="channelInterval">ตรวจคำถามที่ถึงเวลาทุก (วินาที)</label><input id="channelInterval" type="number" min="45" max="600" value="60"><label for="channelBatch">คำถามสูงสุดต่อช่อง / รอบ</label><input id="channelBatch" type="number" min="1" max="8" value="1"></div>
    <div class="row"><button id="startChannelAuto" class="primary">เริ่มถามอัตโนมัติตามช่อง</button><button id="stopChannelAuto">หยุดถามอัตโนมัติ</button></div><p id="channelAutoInfo" class="muted">หยุดอยู่</p>
    <p class="muted">ต้องเปิดหน้านี้ค้างไว้ · โหมดแผนคำถามเสียค่า AI เฉพาะตอนให้ AI ฟังคลิปครั้งแรก · ขณะส่งจริง โทรศัพท์ต้องเปิด TikTok และติดตั้ง ADBKeyBoard ระบบตรวจชื่อช่องก่อนส่งและหยุดเมื่อยืนยันไม่ได้</p>`;
  $('tiktokSettings').before(panel);
  // Queue records must keep their channel identity, including after changing an assignment.
  $('queue')
    .closest('table')
    .querySelector('thead tr')
    .insertBefore(
      Object.assign(document.createElement('th'), { textContent: 'ช่องปลายทาง' }),
      $('queue').closest('table').querySelector('thead th:nth-child(2)'),
    );
  $('libraryVideo').onchange = () => {
    stop();
    ctx.invalidateTranscript();
    const id = $('libraryVideo').value;
    $('libraryPreview').hidden = !id;
    if (id) $('libraryPreview').src = root + '/api/live/videos/' + encodeURIComponent(id) + '/file';
    else $('libraryPreview').removeAttribute('src');
    showPlan(id ? store.get(planKey(id)) : null);
  };
  $('planUse').checked = store.get(useKey) !== false; // plan mode is the default; reading live speech every round costs more
  $('planUse').onchange = () => {
    store.set(useKey, $('planUse').checked);
    stop();
  };
  on('planBuild', buildPlan);
  on('planStop', () => {
    planStop = true;
    planInfo('กำลังหยุดหลังช่วงที่ฟังอยู่…');
  });
  on('planSave', () => {
    const id = $('libraryVideo').value,
      plan = id && store.get(planKey(id));
    if (!plan) throw new Error('ยังไม่มีแผนของคลิปนี้');
    const items = planFromText($('planEditor').value, {
      duration: plan.duration,
      count: 60,
      minGap: 0,
    });
    if (!items.length) throw new Error('ไม่พบบรรทัดที่ถูกต้อง ใช้รูปแบบ 0:45 | คำถาม');
    store.set(planKey(id), { ...plan, items });
    usedPlans.clear();
    showPlan({ ...plan, items });
    ctx.status('บันทึกแผนคำถามแล้ว');
  });
  on('planClear', () => {
    const id = $('libraryVideo').value;
    if (!id) return;
    try {
      localStorage.removeItem(planKey(id));
    } catch {
      /* ignore */
    }
    usedPlans.clear();
    showPlan(null);
    ctx.status('ลบแผนของคลิปนี้แล้ว (บทพูดที่ฟังแล้วยังเก็บไว้)');
  });
  $('audioSource').onchange = sourceChanged;
  on('libraryTranscribe', async () => {
    const videoId = $('libraryVideo').value;
    if (!videoId) throw new Error('เลือกวิดีโอจากคลังก่อน');
    $('libraryTranscribe').disabled = true;
    try {
      ctx.status('กำลังถอดเสียงจากวิดีโอในคลัง…');
      const result = await ctx.api('transcribe-video', {
        videoId,
        startSeconds: Number($('libraryStart').value),
        seconds: Number($('librarySeconds').value),
        transcriptionKey: ctx.transcriptionKey(),
      });
      ctx.setTranscript(result.text);
      ctx.status(`ถอดเสียง ${result.videoName} จากวินาที ${Math.floor(result.startSeconds)} แล้ว`);
    } finally {
      $('libraryTranscribe').disabled = false;
    }
  });
  on('refreshLibrary', refreshCatalog);
  on('startChannelAuto', start);
  on('stopChannelAuto', stop);
  window.addEventListener('beforeunload', () => {
    stop();
    clearInterval(catalogTimer);
  });
  void refreshCatalog().catch((e) => ctx.status(e.message, true));
  catalogTimer = setInterval(() => refreshCatalog().catch(() => {}), 15000);
  return {
    render: renderRoutes,
    stop,
    active: () => auto,
    target: selectedTarget,
    validJob,
    label: (job) => (job.target ? '@' + job.target.handle : '—'),
  };
}
