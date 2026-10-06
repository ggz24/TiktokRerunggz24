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
    questionModels: { openai: 'gpt-4o-mini', openrouter: 'openai/gpt-4o-mini' },
  };
  const hasQuestion = () =>
    saved[activeProvider === 'openrouter' ? 'hasOpenrouterKey' : 'hasOpenaiKey'];
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
        : `คีย์ถอดเสียง: ${saved.hasTranscriptionKey ? 'บันทึกแล้ว' : 'ยังไม่บันทึก'} · คีย์ ${activeProvider === 'openrouter' ? 'OpenRouter' : 'OpenAI'}: ${hasQuestion() ? 'บันทึกแล้ว' : 'ยังไม่บันทึก'}`;
  }
  function capture() {
    const transcriptionKey = $('transcriptionKey').value.trim(),
      questionKey = $('questionKey').value.trim(),
      model = $('questionModel').value.trim();
    return {
      provider: activeProvider,
      transcriptionKey,
      questionKey,
      data: {
        operation: 'save',
        questionProvider: activeProvider,
        questionModels: { [activeProvider]: model },
        ...(transcriptionKey ? { transcriptionKey } : {}),
        ...(questionKey
          ? { [activeProvider === 'openrouter' ? 'openrouterKey' : 'openaiKey']: questionKey }
          : {}),
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
  for (const id of ['transcriptionKey', 'questionKey', 'questionModel'])
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
