// window.confirm() is silently suppressed in embedded browsers (it returns false at once), which
// made every confirmed button look dead. This draws the dialog in the page instead.
export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(5,4,15,.72);padding:16px';
    const box = document.createElement('div');
    box.style.cssText =
      'background:#1f1b3a;border:2px solid #7c5cff;box-shadow:6px 6px 0 rgba(0,0,0,.5);color:#fff;max-width:440px;width:100%;padding:20px;font-size:15px;line-height:1.5';
    const text = document.createElement('p');
    text.textContent = message;
    text.style.cssText = 'margin:0 0 18px;white-space:pre-line';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
    const button = (label: string, background: string, color: string) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.style.cssText = `background:${background};color:${color};border:2px solid #7c5cff;padding:8px 18px;font:inherit;font-weight:700;cursor:pointer`;
      return element;
    };
    const cancel = button('ยกเลิก', 'transparent', '#fff');
    const ok = button('ยืนยัน', '#ff2d87', '#fff');
    const finish = (value: boolean) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(false);
    });
    document.addEventListener('keydown', onKey, true);
    actions.append(cancel, ok);
    box.append(text, actions);
    overlay.append(box);
    document.body.append(overlay);
    cancel.focus();
  });
}
