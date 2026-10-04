/** Additive workspace adapter; the guest page never depends on workspace sign-in/storage. */
const topbar = document.getElementById('topbar');
if (topbar) {
  const attach = () => {
    if (topbar.querySelector('.guest-meeting-entry')) return;
    const link = document.createElement('a');
    link.href = new URL('./meet.html', import.meta.url).href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.className = 'button guest-meeting-entry'; link.title = 'Guest meetings — no account required (opens a new tab)';
    link.setAttribute('aria-label', link.title); link.textContent = 'Guest meeting';
    (topbar.querySelector('.topbar-actions') || topbar).prepend(link);
  };
  const observer = new MutationObserver(attach); observer.observe(topbar, {childList: true, subtree: true}); attach();
  window.addEventListener('pagehide', () => observer.disconnect(), {once: true});
}
