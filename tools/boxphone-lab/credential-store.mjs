import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
const defaults = () => ({
  transcriptionKey: '',
  openaiKey: '',
  openrouterKey: '',
  questionProvider: 'openai',
  questionModels: { openai: 'gpt-4o-mini', openrouter: 'openai/gpt-4o-mini' },
});
const keyFields = ['transcriptionKey', 'openaiKey', 'openrouterKey'];
export function publicSettings(s) {
  return {
    hasTranscriptionKey: !!s.transcriptionKey,
    hasOpenaiKey: !!s.openaiKey,
    hasOpenrouterKey: !!s.openrouterKey,
    questionProvider: s.questionProvider,
    questionModels: s.questionModels,
  };
}
export class CredentialStore {
  constructor(directory, key) {
    this.directory = directory;
    this.key = key;
    this.locks = new Map();
  }
  filename(owner) {
    if (
      typeof owner !== 'string' ||
      !owner.trim() ||
      owner.length > 128 ||
      /[\x00-\x1f]/.test(owner)
    )
      throw Error('ผู้ใช้ไม่ถูกต้อง');
    if (!Buffer.isBuffer(this.key) || this.key.length !== 32)
      throw Error('ยังไม่ได้ตั้งค่าการเข้ารหัสคีย์ Boxphone');
    return path.join(this.directory, createHash('sha256').update(owner).digest('hex') + '.json');
  }
  async load(owner) {
    const filename = this.filename(owner);
    let raw;
    try {
      if ((await stat(filename)).size > 16384) throw Error('oversized');
      raw = await readFile(filename, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return defaults();
      throw Error('อ่านคีย์ที่บันทึกไว้ไม่ได้');
    }
    try {
      const box = JSON.parse(raw);
      if (box.v !== 1) throw Error('version');
      const iv = Buffer.from(box.iv, 'hex'),
        tag = Buffer.from(box.tag, 'hex');
      if (iv.length !== 12 || tag.length !== 16) throw Error('format');
      const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from('boxphone-ai-keys\0' + owner));
      cipher.setAuthTag(tag);
      const payload = JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(box.data, 'base64')), cipher.final()]).toString(
          'utf8',
        ),
      );
      return this.validate(defaults(), payload);
    } catch {
      throw Error('ถอดรหัสคีย์ที่บันทึกไว้ไม่ได้ ตรวจค่าการเข้ารหัสของระบบ');
    }
  }
  validate(current, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw Error('ข้อมูลคีย์ไม่ถูกต้อง');
    const next = { ...current, questionModels: { ...current.questionModels } };
    for (const field of keyFields)
      if (Object.hasOwn(patch, field)) {
        const value = patch[field];
        if (
          typeof value !== 'string' ||
          value.trim().length > 512 ||
          /[\x00-\x20\x7f]/.test(value.trim())
        )
          throw Error('รูปแบบ API key ไม่ถูกต้อง');
        if (value.trim()) next[field] = value.trim(); // Blank fields preserve saved keys; clear() deletes them.
      }
    if (Object.hasOwn(patch, 'questionProvider')) {
      if (!['openai', 'openrouter'].includes(patch.questionProvider))
        throw Error('ผู้ให้บริการไม่ถูกต้อง');
      next.questionProvider = patch.questionProvider;
    }
    if (Object.hasOwn(patch, 'questionModels')) {
      const models = patch.questionModels;
      if (!models || typeof models !== 'object' || Array.isArray(models))
        throw Error('โมเดลไม่ถูกต้อง');
      for (const provider of ['openai', 'openrouter'])
        if (Object.hasOwn(models, provider)) {
          const model = models[provider];
          if (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(model.trim()))
            throw Error('โมเดลไม่ถูกต้อง');
          next.questionModels[provider] = model.trim();
        }
    }
    return next;
  }
  async lock(owner, work) {
    this.filename(owner);
    const prior = this.locks.get(owner) || Promise.resolve(),
      job = prior.catch(() => {}).then(work);
    this.locks.set(owner, job);
    try {
      return await job;
    } finally {
      if (this.locks.get(owner) === job) this.locks.delete(owner);
    }
  }
  async save(owner, patch) {
    return this.lock(owner, async () => {
      const settings = this.validate(await this.load(owner), patch),
        iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from('boxphone-ai-keys\0' + owner));
      const data = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]);
      const box = JSON.stringify({
        v: 1,
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        data: data.toString('base64'),
      });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const filename = this.filename(owner),
        temp = filename + '.' + randomBytes(8).toString('hex') + '.tmp';
      try {
        await writeFile(temp, box, { mode: 0o600, flag: 'wx' });
        await rename(temp, filename);
      } finally {
        await rm(temp, { force: true });
      }
      return publicSettings(settings);
    });
  }
  async clear(owner) {
    return this.lock(owner, async () => {
      await rm(this.filename(owner), { force: true });
      return publicSettings(defaults());
    });
  }
  async metadata(owner) {
    return publicSettings(await this.load(owner));
  }
  async resolve(owner, kind, inline) {
    if (typeof inline === 'string' && inline.trim())
      return this.validate(defaults(), { [kind]: inline })[kind];
    if (!owner) return '';
    return (await this.load(owner))[kind] || '';
  }
}
