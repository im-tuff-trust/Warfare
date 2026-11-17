// Keyboard + mouse input with pointer lock.

export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  mouseDX = 0; mouseDY = 0; wheel = 0;
  lmb = false; rmb = false; rmbPressed = false;
  locked = false;
  enabled = true;
  sensitivity = 1;
  private el: HTMLElement;
  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', this.kd);
    window.addEventListener('keyup', this.ku);
    el.addEventListener('mousedown', this.md);
    window.addEventListener('mouseup', this.mu);
    window.addEventListener('mousemove', this.mm);
    el.addEventListener('wheel', this.wh, { passive: false });
    el.addEventListener('contextmenu', this.cm);
    document.addEventListener('pointerlockchange', this.plc);
    window.addEventListener('blur', this.blur);
  }
  private kd = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (['Tab', 'Space', 'ControlLeft', 'KeyF', 'AltLeft'].includes(e.code)) e.preventDefault();
    if (!this.keys.has(e.code)) this.pressed.add(e.code);
    this.keys.add(e.code);
  };
  private ku = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  private md = (e: MouseEvent) => {
    if (!this.enabled) return;
    if (!this.locked) { this.requestLock(); }
    if (e.button === 0) this.lmb = true;
    if (e.button === 2) { this.rmb = true; this.rmbPressed = true; }
  };
  private mu = (e: MouseEvent) => {
    if (e.button === 0) this.lmb = false;
    if (e.button === 2) this.rmb = false;
  };
  private mm = (e: MouseEvent) => {
    if (!this.locked) return;
    this.mouseDX += e.movementX * this.sensitivity;
    this.mouseDY += e.movementY * this.sensitivity;
  };
  private wh = (e: WheelEvent) => { e.preventDefault(); this.wheel += Math.sign(e.deltaY); };
  private cm = (e: Event) => e.preventDefault();
  private plc = () => { this.locked = document.pointerLockElement === this.el; if (!this.locked) { this.lmb = false; } };
  private blur = () => { this.keys.clear(); this.lmb = false; this.rmb = false; };
  requestLock() {
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* not allowed */ }
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }
  down(code: string) { return this.enabled && this.keys.has(code); }
  hit(code: string) { return this.enabled && this.pressed.has(code); }
  endFrame() { this.pressed.clear(); this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; this.rmbPressed = false; }
  dispose() {
    window.removeEventListener('keydown', this.kd);
    window.removeEventListener('keyup', this.ku);
    this.el.removeEventListener('mousedown', this.md);
    window.removeEventListener('mouseup', this.mu);
    window.removeEventListener('mousemove', this.mm);
    this.el.removeEventListener('wheel', this.wh);
    this.el.removeEventListener('contextmenu', this.cm);
    document.removeEventListener('pointerlockchange', this.plc);
    window.removeEventListener('blur', this.blur);
    this.exitLock();
  }
}
