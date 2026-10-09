'use client';

import { useState } from 'react';

/** A keyword to type into the Network tab filter, with a button that copies it. */
export default function CopyKeyword({ text, hint }: { text: string; hint: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="cyber-copy-keyword">
      <small>{hint}</small>
      <span>
        <code>{text}</code>
        <button className="cyber-btn cyan" type="button" onClick={() => void copy()}>
          {copied ? 'คัดลอกแล้ว ✓' : 'คัดลอก'}
        </button>
      </span>
    </div>
  );
}
