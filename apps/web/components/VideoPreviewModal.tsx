'use client';

import { useEffect } from 'react';
import { apiPath } from '@/lib/base-path';

export default function VideoPreviewModal({
  video,
  onClose,
}: {
  video: { id: string; name: string };
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`ดูวิดีโอ ${video.name}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(5,4,15,.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          background: '#1f1b3a',
          border: '2px solid #7c5cff',
          maxWidth: 560,
          width: '100%',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: 14,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <strong style={{ wordBreak: 'break-all' }}>{video.name}</strong>
          <button className="cyber-btn" type="button" onClick={onClose}>
            ปิด
          </button>
        </div>
        <video
          key={video.id}
          src={apiPath(`/api/live/videos/${encodeURIComponent(video.id)}/file`)}
          controls
          autoPlay
          playsInline
          preload="metadata"
          style={{ width: '100%', maxHeight: '75vh', background: '#000' }}
        />
      </div>
    </div>
  );
}
