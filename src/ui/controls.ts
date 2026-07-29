/**
 * A small declarative control builder.
 *
 * Every control carries an explicit `effect` saying what has to happen when it
 * changes: rebuild the geometry, restart the run, re-aim, or nothing. That is the
 * whole reason this exists rather than reading values off the DOM. Changing the
 * bowl depth invalidates the mesh, the BVH, the film grid and the impingement map;
 * changing the fluid only invalidates the run. Getting that wrong either throws
 * away a run needlessly or, much worse, leaves a stale film grid attached to new
 * geometry.
 */

export type Effect = 'rebuild' | 'restart' | 'aim' | 'view' | 'none';

export interface ControlHost {
  /** Called after any control changes, with the strongest effect requested. */
  apply(effect: Effect): void;
}

interface Refreshable {
  refresh(): void;
}

export class Panel {
  readonly root: HTMLElement;
  private host: ControlHost;
  private refreshables: Refreshable[] = [];

  constructor(host: ControlHost, className = 'panel') {
    this.host = host;
    this.root = document.createElement('div');
    this.root.className = className;
  }

  /** Collapsible group. */
  section(title: string, opts?: { collapsed?: boolean; hint?: string }): Panel {
    const wrap = document.createElement('section');
    wrap.className = 'section';
    const head = document.createElement('button');
    head.className = 'section-head';
    head.type = 'button';
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▾';
    const label = document.createElement('span');
    label.textContent = title;
    head.append(caret, label);
    const body = document.createElement('div');
    body.className = 'section-body';
    if (opts?.collapsed) {
      wrap.classList.add('collapsed');
      caret.textContent = '▸';
    }
    head.addEventListener('click', () => {
      const c = wrap.classList.toggle('collapsed');
      caret.textContent = c ? '▸' : '▾';
    });
    wrap.append(head);
    if (opts?.hint) {
      const h = document.createElement('p');
      h.className = 'hint section-hint';
      h.textContent = opts.hint;
      body.append(h);
    }
    wrap.append(body);
    this.root.append(wrap);

    const sub = new Panel(this.host);
    sub.root.className = 'group';
    body.append(sub.root);
    this.refreshables.push(sub);
    return sub;
  }

  slider(spec: {
    label: string;
    min: number;
    max: number;
    step: number;
    get: () => number;
    set: (v: number) => void;
    /** SI value times this equals the displayed number. */
    display?: number;
    unit?: string;
    decimals?: number;
    effect: Effect;
    hint?: string;
  }): this {
    const disp = spec.display ?? 1;
    const dec = spec.decimals ?? 2;
    const row = document.createElement('div');
    row.className = 'ctl';
    const head = document.createElement('div');
    head.className = 'ctl-head';
    const lab = document.createElement('label');
    lab.textContent = spec.label;
    const val = document.createElement('span');
    val.className = 'ctl-val';
    head.append(lab, val);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min * disp);
    input.max = String(spec.max * disp);
    input.step = String(spec.step * disp);

    const paint = () => {
      const v = spec.get();
      input.value = String(v * disp);
      val.textContent = `${(v * disp).toFixed(dec)}${spec.unit ? ' ' + spec.unit : ''}`;
    };
    input.addEventListener('input', () => {
      spec.set(Number(input.value) / disp);
      paint();
      this.host.apply(spec.effect);
    });
    row.append(head, input);
    if (spec.hint) {
      const h = document.createElement('p');
      h.className = 'hint';
      h.textContent = spec.hint;
      row.append(h);
    }
    this.root.append(row);
    paint();
    this.refreshables.push({ refresh: paint });
    return this;
  }

  select<T extends string>(spec: {
    label: string;
    options: Array<{ value: T; label: string }>;
    get: () => T;
    set: (v: T) => void;
    effect: Effect;
    hint?: string;
  }): this {
    const row = document.createElement('div');
    row.className = 'ctl';
    const lab = document.createElement('label');
    lab.textContent = spec.label;
    const sel = document.createElement('select');
    for (const o of spec.options) {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      sel.append(el);
    }
    const paint = () => {
      sel.value = spec.get();
    };
    sel.addEventListener('change', () => {
      spec.set(sel.value as T);
      this.host.apply(spec.effect);
    });
    row.append(lab, sel);
    if (spec.hint) {
      const h = document.createElement('p');
      h.className = 'hint';
      h.textContent = spec.hint;
      row.append(h);
    }
    this.root.append(row);
    paint();
    this.refreshables.push({ refresh: paint });
    return this;
  }

  toggle(spec: {
    label: string;
    get: () => boolean;
    set: (v: boolean) => void;
    effect: Effect;
    hint?: string;
  }): this {
    const row = document.createElement('label');
    row.className = 'ctl ctl-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    const span = document.createElement('span');
    span.textContent = spec.label;
    const paint = () => {
      box.checked = spec.get();
    };
    box.addEventListener('change', () => {
      spec.set(box.checked);
      this.host.apply(spec.effect);
    });
    row.append(box, span);
    this.root.append(row);
    if (spec.hint) {
      const h = document.createElement('p');
      h.className = 'hint';
      h.textContent = spec.hint;
      this.root.append(h);
    }
    paint();
    this.refreshables.push({ refresh: paint });
    return this;
  }

  button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener('click', onClick);
    this.root.append(b);
    return b;
  }

  buttonRow(): Panel {
    const row = new Panel(this.host);
    row.root.className = 'btn-row';
    this.root.append(row.root);
    this.refreshables.push(row);
    return row;
  }

  /** A read-only line whose value is pulled on refresh. */
  readout(label: string, get: () => string, cls = ''): this {
    const row = document.createElement('div');
    row.className = `kv ${cls}`.trim();
    const l = document.createElement('span');
    l.className = 'kv-k';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'kv-v';
    row.append(l, v);
    this.root.append(row);
    const paint = () => {
      v.textContent = get();
    };
    paint();
    this.refreshables.push({ refresh: paint });
    return this;
  }

  text(content: string, cls = 'hint'): HTMLParagraphElement {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = content;
    this.root.append(p);
    return p;
  }

  raw(el: HTMLElement): this {
    this.root.append(el);
    return this;
  }

  /** Re-read every control's value from the model. */
  refresh(): void {
    for (const r of this.refreshables) r.refresh();
  }

  clear(): void {
    this.root.replaceChildren();
    this.refreshables = [];
  }
}
