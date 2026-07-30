import { App } from './ui/app';
import { attachAutomation } from './ui/automation';

/**
 * Entry point.
 *
 * WebGL failures are reported plainly rather than left as a blank canvas, because
 * a black viewport is indistinguishable from a simulation that produced nothing.
 */
function boot(): void {
  try {
    // The scripted control surface is attached unconditionally. It is a few
    // hundred bytes, it has no effect unless something calls it, and gating it
    // behind a build flag would mean the thing used to verify the app is not
    // present in the app that ships.
    attachAutomation(new App());
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
