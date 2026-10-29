// Screen state and keyboard focus change together; visual fades stay in CSS.
const leavingTimers = new WeakMap();

for (const screen of document.querySelectorAll('.screen')) {
  const active = screen.classList.contains('active');
  screen.inert = !active;
  screen.setAttribute('aria-hidden', String(!active));
}

export function nav(id) {
  const target = document.getElementById(id);
  if (!target?.classList.contains('screen') || target.classList.contains('active')) return;

  clearTimeout(leavingTimers.get(target));
  target.classList.remove('leaving');
  target.inert = false;
  target.setAttribute('aria-hidden', 'false');
  // Register the initial CSS state even when animation frames are paused.
  void target.offsetHeight;
  target.classList.add('active');

  // Move focus before hiding the outgoing screen from assistive technology.
  const heading = target.querySelector('h1, h2, .screen-title');
  const focusTarget = heading || target;
  focusTarget.setAttribute('tabindex', '-1');
  focusTarget.focus({ preventScroll: true });

  for (const screen of document.querySelectorAll('.screen')) {
    if (screen === target) continue;
    screen.inert = true;
    screen.setAttribute('aria-hidden', 'true');
    if (!screen.classList.contains('active')) continue;
    screen.classList.remove('active');
    screen.classList.add('leaving');
    leavingTimers.set(screen, setTimeout(() => {
      screen.classList.remove('leaving');
      leavingTimers.delete(screen);
    }, 300));
  }
}
