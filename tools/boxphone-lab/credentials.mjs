/** Saved keys stay on the authenticated bridge; the browser receives presence flags only. */
export function installCredentials(ctx) {
  const $ = (id) => document.getElementById(id),
    integrated = !!document.querySelector('meta[name="lab-livehub-root"]');
  let activeProvider = $('questionProvider').value,
    loading = integrated,
    pending = Promise.resolve();
  let saved = {
    hasTranscriptionKey: false,
    hasOpenaiKey: false,
    hasOpenrouterKey: false,
    backupCounts: { transcriptionKey: 0, openaiKey: 0, openrouterKey: 0 },
    questionModels: { openai: 'gpt-4o-mini', openrouter: 'openai/gpt-4o-mini' },
  };
  const hasQuestion = () =>
    saved[activeProvider === 'openrouter' ? 'hasOpenrouterKey' : 'hasOpenaiKey'];
  const questionField = () => (activeProvider === 'openrouter' ? 'openrouterKey' : 'openaiKey');
  const backupCount = (field) => saved.backupCounts?.[field] ?? 0;
  // Backup keys: one per line, tried in order when the main key is rejected (wrong, out of quota, rate limited).
  function addBackupBox(afterId, id, label) {
    const box = document.createElement('textarea');
    box.id = id;
    box.rows = 2;
    box.autocomplete = 'off';
    box.spellcheck = false;
    box.placeholder = label;
    box.style.cssText =
      'width:100%;margin-top:6px;-webkit-text-security:disc;text-security:disc;font-family:monospace';
    $(afterId).closest('.row').after(box);
    return box;
  }
  addBackupBox(
    'transcriptionKey',
    'transcriptionBackups',
    'คีย์สำรองถอดเสียง (ไม่บังคับ) บรรทัดละ 1 คีย์ สูงสุด 3 · ใช้เองเมื่อคีย์หลักใช้ไม่ได้',
  );
  addBackupBox(
    'questionKey',
    'questionBackups',
    'คีย์สำรองสร้างคำถาม (ไม่บังคับ) บรรทัดละ 1 คีย์ สูงสุด 3 · ใช้เองเมื่อคีย์หลักใช้ไม่ได้',
  );
  const lines = (id) =>
    $(id)
      .value.split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
  function render() {
    $('transcriptionKey').placeholder = saved.hasTranscriptionKey
      ? 'บันทึกแล้ว · เว้นว่างเพื่อใช้คีย์เดิม'
      : 'กรอก OpenAI API key';
    $('questionKey').placeholder = hasQuestion()
      ? 'บันทึกแล้ว · เว้นว่างเพื่อใช้คีย์เดิม'
      : activeProvider === 'openrouter'
        ? 'กรอก OpenRouter API key'
        : 'กรอก OpenAI API key';
    $('aiKeyHelp').textContent =
      (activeProvider === 'openrouter'
        ? 'OpenRouter: ใส่ชื่อโมเดลตามแค็ตตาล็อก'
        : 'OpenAI: เลือกโมเดลที่บัญชี API ใช้ได้') +
      (integrated ? ' · คีย์เก็บแบบเข้ารหัส แยกผู้ให้บริการและผู้ใช้' : ' · คีย์ใช้เฉพาะหน้านี้');
    $('keySaveStatus').textContent = loading
      ? 'กำลังโหลดคีย์ที่บันทึกไว้…'
      : !integrated
        ? 'เปิดผ่าน Live Hub เพื่อบันทึกคีย์'
        : `คีย์ถอดเสียง: ${saved.hasTranscriptionKey ? 'บันทึกแล้ว' : 'ยังไม่บันทึก'} (สำรอง ${backupCount('transcriptionKey')}) · คีย์ ${activeProvider === 'openrouter' ? 'OpenRouter' : 'OpenAI'}: ${hasQuestion() ? 'บันทึกแล้ว' : 'ยังไม่บันทึก'} (สำรอง ${backupCount(questionField())})`;
  }
  function capture() {
    const transcriptionKey = $('transcriptionKey').value.trim(),
      questionKey = $('questionKey').value.trim(),
      transcriptionBackups = lines('transcriptionBackups'),
      questionBackups = lines('questionBackups'),
      model = $('questionModel').value.trim();
    const backupKeys = {
      ...(transcriptionBackups.length ? { transcriptionKey: transcriptionBackups } : {}),
      ...(questionBackups.length ? { [questionField()]: questionBackups } : {}),
    };
    return {
      provider: activeProvider,
      transcriptionKey,
      questionKey,
      transcriptionBackups: transcriptionBackups.join('\n'),
      questionBackups: questionBackups.join('\n'),
      data: {
        operation: 'save',
        questionProvider: activeProvider,
        questionModels: { [activeProvider]: model },
        ...(transcriptionKey ? { transcriptionKey } : {}),
        ...(questionKey ? { [questionField()]: questionKey } : {}),
        ...(Object.keys(backupKeys).length ? { backupKeys } : {}),
      },
    };
  }
  function enqueue(work) {
    const job = pending.catch(() => {}).then(work);
    pending = job;
    return job;
  }
  async function saveSnapshot(snapshot) {
    if (!integrated) return;
    $('keySaveStatus').textContent = 'กำลังบันทึกคีย์…';
    try {
      const metadata = await enqueue(() => ctx.api('ai-settings', snapshot.data));
      saved = metadata;
      if ($('transcriptionKey').value.trim() === snapshot.transcriptionKey)
        $('transcriptionKey').value = '';
      if (lines('transcriptionBackups').join('\n') === snapshot.transcriptionBackups)
        $('transcriptionBackups').value = '';
      if (lines('questionBackups').join('\n') === snapshot.questionBackups)
        $('questionBackups').value = '';
      if (
        activeProvider === snapshot.provider &&
        $('questionKey').value.trim() === snapshot.questionKey
      )
        $('questionKey').value = '';
      render();
      ctx.status('บันทึกคีย์และโมเดลแล้ว ครั้งต่อไปใช้คีย์เดิมได้');
    } catch (e) {
      $('keySaveStatus').textContent = 'บันทึกไม่สำเร็จ · คีย์ที่กรอกยังอยู่ในช่อง';
      throw e;
    }
  }
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      ctx.status(e.message, true);
    }
  };
  $('saveAiKeys').hidden = !integrated;
  $('saveAiKeys').onclick = run(async () => {
    await ready;
    await saveSnapshot(capture());
  });
  for (const id of [
    'transcriptionKey',
    'questionKey',
    'questionModel',
    'transcriptionBackups',
    'questionBackups',
  ])
    $(id).addEventListener(
      'change',
      run(async () => {
        ctx.stop();
        await ready;
        await saveSnapshot(capture());
      }),
    );
  async function changeProvider() {
    const previous = capture(),
      provider = $('questionProvider').value;
    ctx.stop();
    activeProvider = provider;
    $('questionKey').value = '';
    $('questionModel').value = saved.questionModels[provider];
    render();
    if (integrated) {
      await ready;
      await saveSnapshot(previous);
      await saveSnapshot(capture());
    }
  }
  async function forget() {
    ctx.stop();
    await ready;
    if (integrated) saved = await enqueue(() => ctx.api('ai-settings', { operation: 'delete' }));
    $('transcriptionKey').value = '';
    $('questionKey').value = '';
    $('transcriptionBackups').value = '';
    $('questionBackups').value = '';
    render();
    ctx.status('ลบคีย์ที่บันทึกไว้และหยุดงานอัตโนมัติแล้ว');
  }
  async function load() {
    if (!integrated) {
      render();
      return;
    }
    for (const id of [
      'transcriptionKey',
      'questionKey',
      'questionProvider',
      'questionModel',
      'transcriptionBackups',
      'questionBackups',
      'saveAiKeys',
      'forgetKey',
    ])
      $(id).disabled = true;
    try {
      saved = await ctx.api('ai-settings', { operation: 'load' });
      activeProvider = saved.questionProvider;
      $('questionProvider').value = activeProvider;
      $('questionModel').value = saved.questionModels[activeProvider];
    } catch (e) {
      ctx.status(e.message, true);
    } finally {
      loading = false;
      for (const id of [
        'transcriptionKey',
        'questionKey',
        'questionProvider',
        'questionModel',
        'transcriptionBackups',
        'questionBackups',
        'saveAiKeys',
        'forgetKey',
      ])
        $(id).disabled = false;
      render();
    }
  }
  render();
  const ready = load();
  return {
    changeProvider,
    forget,
    transcriptionKey() {
      if (loading) throw Error('รอโหลดคีย์สักครู่');
      const key = $('transcriptionKey').value.trim();
      if (!key && !saved.hasTranscriptionKey) throw Error('กรอก OpenAI API key สำหรับถอดเสียงก่อน');
      return key;
    },
    questionConfig() {
      if (loading) throw Error('รอโหลดคีย์สักครู่');
      const key = $('questionKey').value.trim(),
        model = $('questionModel').value.trim();
      if (!key && !hasQuestion()) throw Error('กรอก API key สำหรับสร้างคำถามก่อน');
      if (!model) throw Error('กรอกชื่อโมเดลก่อน');
      return { provider: activeProvider, key, model };
    },
  };
}
