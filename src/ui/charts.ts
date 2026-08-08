/**
 * Small canvas time-series plots.
 *
 * Worth having rather than relying on the final numbers alone, because the shape
 * over time is diagnostic in a way a total is not. Film volume that rises and then
 * plateaus means the fixture is filling faster than it drains. Splashback that
 * arrives in one burst points at a specific moment in the flow curve -- usually
 * peak flow, sometimes the ramp where the stream is still coherent. The totals
 * cannot distinguish those cases.
 */

export interface Series {
  label: string;
  color: string;
  /** Value accessor, in display units. */
  value: (i: number) => number;
  /** Right-hand axis instead of left. */
  axis?: 'left' | 'right';
}

export interface ChartOptions {
  title: string;
  leftLabel: string;
  rightLabel?: string;
  series: Series[];
  /** Number of samples currently available. */
  count: () => number;
  /** X value (time) for sample i. */
  time: (i: number) => number;
  /** Vertical markers, e.g. the moment flow stopped. */
  markers?: () => Array<{ t: number; label: string; color: string }>;
}

export class Chart {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private opts: ChartOptions;
  private cssW = 320;
  private cssH = 120;

  constructor(opts: ChartOptions) {
    this.opts = opts;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart';
    const c = this.canvas.getContext('2d');
    if (!c) throw new Error('2D canvas unavailable');
    this.ctx = c;
  }

  resize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = cssWidth;
    this.cssH = cssHeight;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(): void {
    const { ctx, opts } = this;
    const w = this.cssW;
    const h = this.cssH;
    const padL = 42;
    const padR = opts.rightLabel ? 42 : 10;
    const padT = 18;
    const padB = 20;
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, h - padT - padB);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f151c';
    ctx.fillRect(0, 0, w, h);

    const n = opts.count();
    ctx.fillStyle = '#8fa3b8';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.title, padL, 3);

    if (n < 2) {
      ctx.fillStyle = '#4a5a6b';
      ctx.fillText('no data yet', padL, padT + plotH * 0.4);
      return;
    }

    const t0 = opts.time(0);
    const t1 = opts.time(n - 1);
    const tSpan = Math.max(1e-6, t1 - t0);

    // Independent autoscale per axis: the series on one axis share units, the
    // series on the other do not, and forcing them onto one range would flatten
    // whichever has the smaller magnitude into the baseline.
    const bounds = (axis: 'left' | 'right') => {
      let mx = 0;
      let found = false;
      for (const s of opts.series) {
        if ((s.axis ?? 'left') !== axis) continue;
        for (let i = 0; i < n; i++) {
          const v = s.value(i);
          if (Number.isFinite(v)) {
            if (v > mx) mx = v;
            found = true;
          }
        }
      }
      return found ? Math.max(mx, 1e-9) : 0;
    };
    const maxL = bounds('left');
    const maxR = bounds('right');

    // Grid.
    ctx.strokeStyle = '#1c2733';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
    }
    ctx.stroke();

    // Axis labels.
    ctx.fillStyle = '#6b7f94';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const frac = 1 - i / 4;
      ctx.fillText(fmt(maxL * frac), padL - 5, padT + (plotH * i) / 4);
    }
    if (opts.rightLabel && maxR > 0) {
      ctx.textAlign = 'left';
      for (let i = 0; i <= 4; i++) {
        const frac = 1 - i / 4;
        ctx.fillText(fmt(maxR * frac), padL + plotW + 5, padT + (plotH * i) / 4);
      }
    }
    // The axis units.
    //
    // `leftLabel` was declared on the options, supplied by all three charts with a
    // real unit -- mL/s, µL, µL -- and read by nothing at all; `rightLabel` was read
    // only as a boolean, to decide padding and whether to draw the right-hand tick
    // numbers. So every chart shipped with unlabelled axes, and 'count', the unit
    // of the live-droplet series, appeared nowhere in the product. A field that is
    // supplied and never read is the same defect as one that is reported and never
    // written: it looks handled.
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.translate(9, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(opts.leftLabel, 0, 0);
    ctx.restore();
    if (opts.rightLabel && maxR > 0) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.translate(w - 9, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(opts.rightLabel, 0, 0);
      ctx.restore();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${t0.toFixed(0)} s`, padL, padT + plotH + 4);
    ctx.fillText(`${t1.toFixed(1)} s`, padL + plotW, padT + plotH + 4);

    // Markers.
    if (opts.markers) {
      for (const m of opts.markers()) {
        if (m.t < t0 || m.t > t1) continue;
        const x = padL + ((m.t - t0) / tSpan) * plotW;
        ctx.strokeStyle = m.color;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = m.color;
        ctx.textAlign = 'left';
        ctx.fillText(m.label, x + 3, padT + 1);
      }
    }

    // Series.
    for (const s of opts.series) {
      const axis = s.axis ?? 'left';
      const max = axis === 'left' ? maxL : maxR;
      if (max <= 0) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      // Decimate to roughly one point per pixel; drawing thousands of samples
      // into a 300 px wide plot is wasted work.
      const stride = Math.max(1, Math.floor(n / plotW));
      for (let i = 0; i < n; i += stride) {
        const v = s.value(i);
        if (!Number.isFinite(v)) continue;
        const x = padL + ((opts.time(i) - t0) / tSpan) * plotW;
        const y = padT + plotH - (v / max) * plotH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Legend.
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    let lx = padL + 2;
    for (const s of opts.series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, padT + 2, 7, 3);
      ctx.fillStyle = '#8fa3b8';
      const label = s.label + ((s.axis ?? 'left') === 'right' ? ' ›' : '');
      ctx.fillText(label, lx + 11, padT - 1);
      lx += ctx.measureText(label).width + 24;
    }
  }
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toExponential(0);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toExponential(1);
}

/** Horizontal bar breakdown, used for the per-zone splashback tally. */
export class BarList {
  readonly root: HTMLElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'barlist';
  }

  set(rows: Array<{ label: string; value: number; display: string; color: string }>): void {
    const max = Math.max(1e-12, ...rows.map((r) => r.value));
    this.root.replaceChildren();
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'bar-row';
      const lab = document.createElement('span');
      lab.className = 'bar-label';
      lab.textContent = r.label;
      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = `${Math.max(0, Math.min(100, (r.value / max) * 100))}%`;
      fill.style.background = r.color;
      track.append(fill);
      const val = document.createElement('span');
      val.className = 'bar-value';
      val.textContent = r.display;
      row.append(lab, track, val);
      this.root.append(row);
    }
  }
}
