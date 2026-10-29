const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function setup() {
  const timers = new Map();
  let timerId = 0;
  const document = { activeElement: null };
  function screen(id, active, hasHeading = true) {
    const classes = new Set(['screen', ...(active ? ['active'] : [])]);
    const element = {
      id, attrs: {}, inert: false, offsetHeight: 100,
      classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) },
      setAttribute(key, value) {
        if (key === 'aria-hidden' && value === 'true') {
          assert.notEqual(document.activeElement?.screen, this, 'focus must leave before aria-hidden');
        }
        this.attrs[key] = value;
      },
      focus(options) { assert.equal(this.inert, false); document.activeElement = this; this.focusOptions = options; },
      querySelector() { return this.heading || null; },
    };
    element.screen = element;
    if (hasHeading) element.heading = {
      screen: element, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      focus(options) { assert.equal(element.inert, false); document.activeElement = this; this.focusOptions = options; },
    };
    return element;
  }
  const home = screen('screen-home', true);
  const form = screen('screen-form', false);
  const results = screen('screen-results', false, false);
  const screens = [home, form, results];
  document.querySelectorAll = () => screens;
  document.getElementById = id => screens.find(s => s.id === id) || null;
  const context = vm.createContext({ document, WeakMap,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const source = readFileSync(join(__dirname, '../public/js/nav.js'), 'utf8');
  vm.runInContext(source.replace('export function nav', 'function nav') + '\nglobalThis.navigate = nav;', context);
  return { ...context, document, home, form, results, screens,
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
  };
}

test('only the initial active screen is available before navigation', () => {
  const { home, form, results } = setup();
  assert.equal(home.inert, false);
  for (const screen of [form, results]) {
    assert.equal(screen.inert, true);
    assert.equal(screen.attrs['aria-hidden'], 'true');
  }
  const html = readFileSync(join(__dirname, '../public/index.html'), 'utf8');
  const screens = html.match(/<(?:main|div)\b[^>]*class="screen(?:\s[^"]*)?"[^>]*>/g);
  assert.ok(screens.length >= 5);
  for (const tag of screens.filter(tag => !/class="[^"]*\bactive\b/.test(tag))) {
    assert.match(tag, /\binert\b/);
    assert.match(tag, /aria-hidden="true"/);
  }
});

test('navigation moves focus before hiding outgoing controls and preserves fades', () => {
  const app = setup();
  app.document.activeElement = app.home.heading;
  app.navigate('screen-form');
  assert.equal(app.document.activeElement, app.form.heading);
  assert.equal(app.form.heading.attrs.tabindex, '-1');
  assert.equal(app.form.heading.focusOptions.preventScroll, true);
  assert.equal(app.form.inert, false);
  assert.equal(app.form.attrs['aria-hidden'], 'false');
  assert.equal(app.home.inert, true);
  assert.equal(app.home.classList.contains('leaving'), true);
  app.flush();
  assert.equal(app.home.classList.contains('leaving'), false);
});

test('returning rapidly to a screen leaves only the current screen interactive', () => {
  const app = setup();
  app.navigate('screen-form');
  app.navigate('screen-home');
  app.navigate('screen-form');
  app.flush();
  assert.equal(app.document.activeElement, app.form.heading);
  for (const screen of app.screens) {
    assert.equal(screen.inert, screen !== app.form);
    assert.equal(screen.classList.contains('active'), screen === app.form);
    assert.equal(screen.classList.contains('leaving'), false);
  }
});

test('invalid and repeated destinations do not disrupt focus or screen state', () => {
  const app = setup();
  app.document.activeElement = app.home.heading;
  app.navigate('missing');
  app.navigate('screen-home');
  assert.equal(app.document.activeElement, app.home.heading);
  assert.equal(app.home.inert, false);
  assert.equal(app.home.classList.contains('active'), true);
});

test('a screen without a heading receives focus itself', () => {
  const app = setup();
  app.navigate('screen-results');
  assert.equal(app.document.activeElement, app.results);
  assert.equal(app.results.attrs.tabindex, '-1');
  assert.equal(app.results.focusOptions.preventScroll, true);
});
