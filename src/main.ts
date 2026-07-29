import { App } from './ui/app';

/**
 * Entry point.
 *
 * WebGL failures are reported plainly rather than left as a blank canvas, because
 * a black viewport is indistinguishable from a simulation that produced nothing.
 */
function boot(): void {
  try {
    new App();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stage = document.getElementById('stage');
    if (stage) {
      stage.innerHTML =
        `<div style="padding:24px;color:#ff5a3c;font:13px ui-monospace,monospace">` +
        `<strong>Failed to start.</strong><br><br>${escapeHtml(msg)}<br><br>` +
        `<span style="color:#8fa3b8">This build needs WebGL 2. ` +
        `If the browser supports it, check the console for detail.</span></div>`;
    }
    throw err;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
