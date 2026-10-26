/*!
 * direccionesbitcoin.com
 * Generador de direcciones Bitcoin SegWit (bc1q) con frase BIP39 y cartera de papel PDF.
 * Diseño y código: Félix Loureiro Etcheverría — https://www.felixle.com
 */
import './styles/fonts.css';
import './styles/main.css';
import QRCode from 'qrcode';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { inject } from '@vercel/analytics';
import { dict, type Lang } from './i18n';
import { renderBody } from './content';
import type { SceneApi } from './scene';
import { seal, watchAuthorship, onAuthorshipBroken } from './lib/sig';
import { addUserEntropy, userEntropyBits, generateWallet, type Wallet, type Words } from './lib/wallet';

gsap.registerPlugin(ScrollTrigger);

declare const __OFFLINE__: boolean;
const OFFLINE = typeof __OFFLINE__ !== 'undefined' && __OFFLINE__;

let lang: Lang = (document.documentElement.lang as Lang) === 'en' ? 'en' : 'es';
if (OFFLINE) {
  try {
    const saved = localStorage.getItem('db-lang');
    if (saved === 'en' || saved === 'es') lang = saved;
    else if (navigator.language.toLowerCase().startsWith('en')) lang = 'en';
  } catch {
    /* sin almacenamiento */
  }
}

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

let scene: SceneApi | null = null;
let lenis: Lenis | null = null;
let current: Wallet | null = null;
let batch: Wallet[] = [];
let revealed = false;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- Utilidades ---------- */
let toastTimer = 0;
function toast(msg: string) {
  const el = $('[data-toast]');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

function groupAddr(a: string) {
  return (a.match(/.{1,4}/g) ?? [a]).map((g, i) => `<span class="${i % 2 ? 'b' : 'a'}">${g}</span>`).join('');
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/* ---------- Render (en la web el HTML llega pre-renderizado; offline se monta aquí) ---------- */
function mount() {
  const root = $('#root');
  root.innerHTML = renderBody(lang, { offline: OFFLINE, hash: '', size: '' });
  document.documentElement.lang = lang;
  document.title = dict[lang].htmlTitle;
}

/* ---------- Scroll suave y apariciones ---------- */
function initScroll() {
  ScrollTrigger.getAll().forEach((s) => s.kill());
  if (!lenis && !reduced) {
    lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((time) => lenis!.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  $$('a[href^="#"]').forEach((a) =>
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href')!;
      if (id.length < 2) return;
      const target = document.querySelector<HTMLElement>(id);
      if (!target) return;
      e.preventDefault();
      if (lenis) lenis.scrollTo(target, { offset: -70, duration: 1.4 });
      else target.scrollIntoView();
    }),
  );

  const nav = $('[data-nav]');
  ScrollTrigger.create({ start: 40, end: 'max', onToggle: (s) => nav.classList.toggle('solid', s.isActive) });

  if (reduced) {
    $$('.reveal').forEach((el) => el.classList.add('in'));
    return;
  }
  $$('.reveal').forEach((el) => {
    ScrollTrigger.create({ trigger: el, start: 'top 90%', once: true, onEnter: () => el.classList.add('in') });
  });
  const meter = document.querySelector('[data-meter] .meter-bar i');
  if (meter) {
    gsap.fromTo(
      meter,
      { scaleX: 0 },
      { scaleX: 1, ease: 'power3.out', duration: 1.6, scrollTrigger: { trigger: meter, start: 'top 85%' } },
    );
  }
}

/* ---------- Entropía del usuario ---------- */
function initEntropy() {
  const pad = $('[data-entropy-pad]');
  const zone = $('#generar');
  const val = $('[data-entropy-val]');
  const bar = $('[data-entropy-bar]');
  let last = 0;
  const feed = (x: number, y: number) => {
    const now = performance.now();
    addUserEntropy(x, y, now * 1000, (x * 31) ^ (y * 17));
    if (now - last > 30) {
      scene?.energize(0.06);
      last = now;
    }
    const pct = Math.round((userEntropyBits() / 256) * 100);
    val.textContent = `${pct}%`;
    bar.style.transform = `scaleX(${pct / 100})`;
    pad.classList.toggle('full', pct >= 100);
  };
  zone.addEventListener('pointermove', (e) => feed(e.clientX, e.clientY), { passive: true });
  pad.addEventListener(
    'touchmove',
    (e) => {
      for (const t of Array.from(e.touches)) feed(t.clientX, t.clientY);
    },
    { passive: true },
  );
}

/* ---------- Tarjeta 3D (CSS) ---------- */
function initCard() {
  const card = $('[data-card]');
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    card.style.setProperty('--rx', `${(-y * 10).toFixed(2)}deg`);
    card.style.setProperty('--ry', `${(x * 14).toFixed(2)}deg`);
    card.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`);
    card.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`);
  });
  card.addEventListener('pointerleave', () => {
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
  });
  $('[data-card-inner]').addEventListener('click', () => {
    if (current) card.classList.toggle('flipped');
  });
}

async function fillCard(w: Wallet, animate: boolean) {
  const t = dict[lang].gen;
  const card = $('[data-card]');
  await QRCode.toCanvas($<HTMLCanvasElement>('[data-qr-addr]'), `bitcoin:${w.address}`, {
    width: 220,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b0b0b', light: '#ffffff' },
  });
  $('[data-addr]').innerHTML = groupAddr(w.address);
  const seed = $('[data-seed]');
  seed.innerHTML = w.words.map((x, i) => `<li><i>${String(i + 1).padStart(2, '0')}</i>${x}</li>`).join('');
  seed.classList.toggle('w24', w.words.length === 24);
  $('[data-wif]').textContent = w.wif;
  $('[data-words-count]').textContent = `${w.words.length} ${lang === 'es' ? 'palabras' : 'words'}`;
  $('[data-path]').textContent = w.path;
  card.classList.remove('is-empty', 'flipped');
  $('[data-actions]').hidden = false;
  $('[data-volatile]').hidden = false;
  $('[data-generate-label]').textContent = t.again;
  setRevealed(false);
  if (animate && !reduced) {
    gsap.fromTo(
      '[data-card]',
      { rotateY: -180, scale: 0.86, opacity: 0.2 },
      { rotateY: 0, scale: 1, opacity: 1, duration: 1.3, ease: 'expo.out', clearProps: 'rotate,rotateY,scale,opacity,transform' },
    );
  }
}

function setRevealed(v: boolean) {
  revealed = v;
  const t = dict[lang].gen;
  $('[data-seed]').classList.toggle('is-hidden', !v);
  $('[data-wif]').classList.toggle('is-hidden', !v);
  $('[data-reveal]').setAttribute('aria-pressed', String(v));
  $('[data-reveal-label]').textContent = v ? t.hide : t.reveal;
}

function selectedWords(): Words {
  const r = document.querySelector<HTMLInputElement>('[data-words] input:checked');
  return r?.value === '24' ? 24 : 12;
}

/* ---------- Generador individual ---------- */
function initGenerator() {
  const t = dict[lang].gen;
  $('[data-generate]').addEventListener('click', async () => {
    try {
      current = generateWallet(selectedWords());
    } catch (e) {
      toast((e as Error).message);
      return;
    }
    scene?.celebrate();
    await fillCard(current, true);
  });
  $('[data-reveal]').addEventListener('click', () => {
    setRevealed(!revealed);
    if (revealed) $('[data-card]').classList.add('flipped');
  });
  $('[data-flip]').addEventListener('click', () => $('[data-card]').classList.toggle('flipped'));
  $('[data-copy]').addEventListener('click', async () => {
    if (!current) return;
    if (await copyText(current.address)) {
      $('[data-copy-label]').textContent = t.copied;
      setTimeout(() => ($('[data-copy-label]').textContent = t.copy), 1800);
    }
  });
  $('[data-pdf]').addEventListener('click', async () => {
    if (!current) return;
    const label = $('[data-pdf-label]');
    label.textContent = t.pdfBusy;
    try {
      const { buildPdf, downloadBlob } = await import('./lib/pdf');
      const blob = await buildPdf([current], dict[lang].pdf, lang);
      downloadBlob(blob, `${lang === 'es' ? 'cartera-bitcoin' : 'bitcoin-wallet'}-${current.address.slice(0, 12)}.pdf`);
    } catch (e) {
      console.error(e);
      toast('PDF error');
    } finally {
      label.textContent = t.pdf;
    }
  });
  if (current) void fillCard(current, false);
}

/* ---------- Generación masiva ---------- */
function initBulk() {
  const t = dict[lang].bulk;
  const form = $<HTMLFormElement>('[data-bulk-form]');
  const input = $<HTMLInputElement>('input[name="count"]', form);
  const out = $('[data-bulk-out]');
  const rows = $('[data-bulk-rows]');
  const clamp = () => {
    const n = Math.max(2, Math.min(100, Math.round(Number(input.value) || 2)));
    input.value = String(n);
    return n;
  };
  $$('[data-step]', form).forEach((b) =>
    b.addEventListener('click', () => {
      input.value = String(Number(input.value) + Number(b.dataset.step));
      clamp();
    }),
  );
  const renderBatch = () => {
    out.hidden = batch.length === 0;
    $('[data-bulk-count]').textContent = String(batch.length);
    rows.innerHTML = batch
      .map((w, i) => `<tr><td>${i + 1}</td><td><code>${w.address}</code></td><td>${w.words.length}</td></tr>`)
      .join('');
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = clamp();
    const words: Words = $<HTMLSelectElement>('select[name="words"]', form).value === '24' ? 24 : 12;
    const btn = $<HTMLButtonElement>('[data-bulk-btn]');
    const label = $('[data-bulk-label]');
    btn.disabled = true;
    batch = [];
    for (let i = 0; i < n; i++) {
      batch.push(generateWallet(words));
      if (i % 4 === 3) {
        label.textContent = `${t.busy} ${i + 1}/${n}`;
        scene?.energize(0.15);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    label.textContent = t.btn;
    btn.disabled = false;
    scene?.celebrate();
    renderBatch();
  });
  $('[data-bulk-pdf]').addEventListener('click', async () => {
    if (!batch.length) return;
    const label = $('[data-bulk-pdf-label]');
    label.textContent = dict[lang].gen.pdfBusy;
    await new Promise((r) => setTimeout(r, 30));
    try {
      const { buildPdf, downloadBlob } = await import('./lib/pdf');
      const blob = await buildPdf(batch, dict[lang].pdf, lang);
      downloadBlob(blob, `${lang === 'es' ? 'carteras-bitcoin-lote' : 'bitcoin-wallets-batch'}-${batch.length}.pdf`);
    } catch (e) {
      console.error(e);
      toast('PDF error');
    } finally {
      label.textContent = t.pdf;
    }
  });
  $('[data-bulk-csv]').addEventListener('click', async () => {
    if (!batch.length) return;
    const { downloadBlob } = await import('./lib/pdf');
    const csv = ['index,address,derivation_path', ...batch.map((w, i) => `${i + 1},${w.address},${w.path}`)].join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `direcciones-bitcoin-${batch.length}.csv`);
  });
  $('[data-bulk-clear]').addEventListener('click', () => {
    batch = [];
    renderBatch();
  });
  renderBatch();
}

/* ---------- Estado de red ---------- */
function initNet() {
  const t = dict[lang].gen;
  const el = $('[data-net]');
  const note = $('[data-net-note]');
  const upd = () => {
    const on = navigator.onLine;
    el.classList.toggle('off', !on);
    $('em', el).textContent = on ? 'online' : 'offline';
    el.title = on ? t.offlineOff : t.offlineOn;
    note.textContent = on ? t.offlineOff : t.offlineOn;
    note.classList.toggle('ok', !on);
  };
  addEventListener('online', upd);
  addEventListener('offline', upd);
  upd();
}

/* ---------- Botones magnéticos ---------- */
function initMagnetic() {
  if (reduced || matchMedia('(pointer: coarse)').matches) return;
  $$('.magnetic').forEach((b) => {
    b.addEventListener('pointermove', (e) => {
      const r = b.getBoundingClientRect();
      gsap.to(b, {
        x: (e.clientX - r.left - r.width / 2) * 0.18,
        y: (e.clientY - r.top - r.height / 2) * 0.3,
        duration: 0.4,
        ease: 'power3.out',
      });
    });
    b.addEventListener('pointerleave', () => gsap.to(b, { x: 0, y: 0, duration: 0.6, ease: 'elastic.out(1,0.4)' }));
  });
}

/* ---------- Idioma en la versión offline (sin recargar) ---------- */
function initLang() {
  if (!OFFLINE) return;
  const a = $('[data-lang-switch]');
  a.addEventListener('click', (e) => {
    e.preventDefault();
    lang = a.dataset.langSwitch === 'en' ? 'en' : 'es';
    try {
      localStorage.setItem('db-lang', lang);
    } catch {
      /* sin almacenamiento */
    }
    boot();
  });
}

function boot() {
  if (OFFLINE) mount();
  initScroll();
  initEntropy();
  initCard();
  initGenerator();
  initBulk();
  initNet();
  initMagnetic();
  initLang();
  scene?.setAnchorsRoot(document);
  requestAnimationFrame(() => ScrollTrigger.refresh());
}

async function start() {
  // Initialize Vercel Web Analytics
  inject();
  
  boot();
  document.documentElement.classList.add('ready');
  // Sin autoría original no hay web
  onAuthorshipBroken(() => {
    current = null;
    batch = [];
    lenis?.destroy();
    ScrollTrigger.getAll().forEach((s) => s.kill());
  });
  if (!seal({ ld: !OFFLINE })) return;
  watchAuthorship({ ld: !OFFLINE });
  try {
    // la textura de la moneda usa Space Grotesk: esperamos a la fuente
    await document.fonts.load('600 38px "Space Grotesk Variable"');
  } catch {
    /* la fuente es opcional */
  }
  try {
    const { createScene } = await import('./scene');
    scene = createScene($<HTMLCanvasElement>('#scene'));
  } catch {
    scene = null;
  }
  if (!scene) document.documentElement.classList.add('no-webgl');
  else scene.setAnchorsRoot(document);
  console.log(
    '%c₿ direccionesbitcoin.com%c\nDiseño y código: Félix Loureiro Etcheverría · felixle.com\nTus claves se generan en este navegador y nunca salen de él.',
    'color:#F7931A;font:700 16px sans-serif',
    'color:#999;font:12px sans-serif',
  );
}

// Olvida los secretos al salir de la página
addEventListener('pagehide', () => {
  current = null;
  batch = [];
});

void start();
