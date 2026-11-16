// Game shell: owns the battle, view, camera, input, HUD and the main loop.

import * as THREE from 'three';
import { Battle, DT, fatigueLevel } from '../sim/battle';
import type { ArmySpec } from '../sim/battle';
import type { Unit } from '../sim/battle';
import { BattleAI } from '../sim/ai';
import { FACTIONS } from '../sim/data';
import type { UnitSize } from '../sim/data';
import { BattleView } from '../render/view';
import { loadUnitAsset } from '../render/crowd';
import { loadTrees } from '../render/trees';
import type { TreeKind } from '../render/trees';
import type { UnitAsset } from '../render/crowd';
import { UNITS } from '../sim/data';
import { RtsCamera } from './camera';
import { ICONS } from './icons';

export interface GameSettings {
  seed: number;
  playerFaction: 'rome' | 'gauls';
  size: UnitSize;
  /** Campaign battles: explicit armies (side 0 is the player), terrain and how the AI behaves. */
  campaign?: {
    armies: [ArmySpec, ArmySpec];
    land: { hills: number; dry: number };
    title: string;
    aiHold: number;
    onEnd: (b: Battle, withdrew: boolean) => void;
  };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Ptr {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t: number;
  button: number;
  type: string;
}

type Drag =
  | { kind: 'pan'; moved: boolean }
  | { kind: 'rotate'; moved: boolean }
  | { kind: 'box'; moved: boolean }
  | { kind: 'line'; moved: boolean; sx: number; sz: number; ex: number; ez: number; ok: boolean }
  | { kind: 'pinch'; moved: boolean; d: number; a: number; my: number };

interface PlanItem {
  u: Unit;
  x: number;
  z: number;
  fx: number;
  fz: number;
  files: number;
  w: number;
  d: number;
}

export class Game {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  battle!: Battle;
  view!: BattleView;
  cam!: RtsCamera;
  settings!: GameSettings;
  ai: (BattleAI | null)[] = [null, null];
  player = 0;
  enemy = 1;
  selected = new Set<number>();
  focus = -1;
  hover = -1;
  paused = true;
  started = false;
  speed = 1;
  runMode = false;
  lineMode = false;
  multiMode = false;
  autoPlayer = false;
  private acc = 0;
  private lastT = 0;
  private banners: HTMLElement[] = [];
  private cards = new Map<number, HTMLElement>();
  private evIdx = 0;
  private endShown = false;
  private endTimer = 0;
  private hudTimer = 0;
  private ptrs = new Map<number, Ptr>();
  private drag: Drag | null = null;
  private pinchLock = false;
  private plan: PlanItem[] = [];
  private lastTap = { t: 0, x: 0, y: 0 };
  private lastRight = { t: 0, x: 0, y: 0 };
  private raycaster = new THREE.Raycaster();
  private running = false;
  private groups = new Map<number, number[]>();
  private lastGroupKey = { n: -1, t: 0 };
  private ghostBuf = new Float32Array(2 * 400);
  private portraits = new Map<string, string>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.bindInput();
    this.bindHud();
    window.addEventListener('resize', () => this.resize());
  }

  // ------------------------------------------------------------------ lifecycle
  private assets = new Map<string, UnitAsset>();
  private trees: TreeKind[] | null = null;

  private startToken = 0;

  async start(settings: GameSettings) {
    const token = ++this.startToken;
    this.settings = settings;
    // Load the 3D soldier models once.
    const models = [...new Set(Object.values(UNITS).map((d) => d.model).filter((m): m is string => !!m))];
    const missing = models.filter((m) => !this.assets.has(m));
    const extra = settings.campaign ? settings.campaign.armies.flatMap((a) => a.units.map((u) => UNITS[u.unit]?.model)).filter((m): m is string => !!m && !this.assets.has(m) && !models.includes(m)) : [];
    missing.push(...new Set(extra));
    if (missing.length || !this.trees) {
      $('loading').hidden = false;
      const [loaded, trees] = await Promise.all([Promise.all(missing.map((m) => loadUnitAsset(m))), loadTrees()]);
      missing.forEach((m, k) => {
        const a = loaded[k];
        if (a) this.assets.set(m, a);
      });
      this.trees = trees;
      $('loading').hidden = true;
    }
    if (token !== this.startToken) return; // a newer start() took over
    if (this.view) this.view.dispose();
    const camp = settings.campaign;
    this.player = camp ? 0 : settings.playerFaction === 'rome' ? 0 : 1;
    this.enemy = 1 - this.player;
    this.battle = new Battle({
      seed: settings.seed, size: settings.size, factions: ['rome', 'gauls'], aiSides: [this.player !== 0, this.player !== 1],
      armies: camp?.armies, land: camp?.land,
    });
    this.view = new BattleView(this.renderer, this.battle, this.assets, this.trees);
    this.cam = new RtsCamera(this.view.camera, this.battle.terrain);
    const dir = this.player === 0 ? 1 : -1;
    this.cam.jump(0, dir * 120, this.player === 0 ? 0 : Math.PI, 175, 0.55);
    for (const u of this.battle.units) if (u.side === this.player) u.guard = true;
    this.ai = [null, null];
    this.ai[this.enemy] = new BattleAI(this.enemy, camp ? camp.aiHold : 25);
    this.ai[this.player] = this.autoPlayer ? new BattleAI(this.player, 5) : null;
    this.selected.clear();
    this.groups.clear();
    this.portraits.clear();
    this.focus = -1;
    this.hover = -1;
    this.paused = true;
    this.started = false;
    this.speed = 1;
    this.acc = 0;
    this.evIdx = 0;
    this.endShown = false;
    this.endTimer = 0;
    this.plan = [];
    this.buildBanners();
    this.buildCards();
    $('end').hidden = true;
    $('toasts').innerHTML = '';
    $('title').textContent = camp ? camp.title : `${FACTIONS[settings.playerFaction].name} vs ${FACTIONS[settings.playerFaction === 'rome' ? 'gauls' : 'rome'].name}`;
    this.campaignMode(!!camp);
    this.toast('Deploy your army, then press Start battle', 'info', 6);
    this.updateTopBar();
    this.updateOrderButtons();
    this.resize();
    if (!this.running) {
      this.running = true;
      this.lastT = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.view) this.view.resize(w, h);
  }

  /** True while another screen (the campaign map) owns the canvas. */
  suspended = false;

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    const dtReal = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (this.suspended || !this.view) return;
    const b = this.battle;
    if (!this.paused) {
      this.acc += dtReal * this.speed;
      let steps = 0;
      while (this.acc >= DT && steps < 12) {
        this.ai[0]?.update(b);
        this.ai[1]?.update(b);
        b.step();
        this.acc -= DT;
        steps++;
      }
      if (steps >= 12) this.acc = 0;
    }
    this.cam.update(dtReal);
    for (const id of [...this.selected]) {
      const u = b.units[id];
      if (!u || u.gone || u.alive === 0) this.selected.delete(id);
    }
    this.updateTints();
    this.view.update(this.paused ? 1 : this.acc / DT, this.paused ? 0 : dtReal * this.speed);
    this.drawOverlay();
    this.view.render();
    this.updateBanners();
    this.hudTimer -= dtReal;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.2;
      this.updateCards();
      this.updateInfo();
      this.updateTopBar();
    }
    this.processEvents();
    if (b.result && !this.endShown) {
      this.endTimer += dtReal;
      if (this.endTimer > 2.5) this.showEnd();
    }
  }

  // ------------------------------------------------------------------ picking
  private ray(x: number, y: number) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.view.camera);
    return this.raycaster.ray;
  }

  /** Ray march against the heightfield, optionally offset above the ground. */
  private pickGround(x: number, y: number, above = 0): { x: number; z: number } | null {
    const ray = this.ray(x, y);
    const t = this.battle.terrain;
    const o = ray.origin;
    const d = ray.direction;
    let prev = 0;
    const f = (s: number) => o.y + d.y * s - (t.height(o.x + d.x * s, o.z + d.z * s) + above);
    if (f(0) < 0) return null;
    for (let s = 1; s < 4000; s += Math.max(1, s * 0.01)) {
      if (f(s) <= 0) {
        let a = prev;
        let bb = s;
        for (let k = 0; k < 14; k++) {
          const m = (a + bb) / 2;
          if (f(m) > 0) a = m;
          else bb = m;
        }
        const px = o.x + d.x * bb;
        const pz = o.z + d.z * bb;
        if (Math.abs(px) > 395 || Math.abs(pz) > 395) return null;
        return { x: px, z: pz };
      }
      prev = s;
    }
    return null;
  }

  private pickUnit(x: number, y: number): number {
    const b = this.battle;
    for (const [above, r] of [
      [1.2, 1.4],
      [0, 2.4],
    ] as const) {
      const p = this.pickGround(x, y, above);
      if (!p) continue;
      const s = b.nearest(p.x, p.z, r + (above === 0 ? 0.6 : 0.3), () => true);
      if (s >= 0) return b.unitOf[s];
    }
    return -1;
  }

  // ------------------------------------------------------------------ commands
  private ownSelected(): Unit[] {
    return [...this.selected].map((id) => this.battle.units[id]).filter((u) => u && u.active && u.side === this.player);
  }

  private clickUnit(id: number, additive: boolean, touch: boolean, dbl: boolean) {
    const u = this.battle.units[id];
    if (!u) return;
    if (u.side === this.player) {
      if (additive || this.multiMode) {
        if (this.selected.has(id)) this.selected.delete(id);
        else this.selected.add(id);
      } else if (!dbl && this.selected.size === 1 && this.selected.has(id)) {
        // Clicking the selected unit again deselects it.
        this.clearSelection();
        return;
      } else {
        this.selected.clear();
        this.selected.add(id);
      }
      this.focus = this.selected.has(id) ? id : [...this.selected][0] ?? -1;
      if (dbl) {
        // Double click: every unit of the same type.
        for (const o of this.battle.units) if (o.side === this.player && o.active && o.def.id === u.def.id) this.selected.add(o.id);
      }
    } else {
      if (touch && this.ownSelected().length > 0) this.attack(id, this.runMode || dbl);
      else this.focus = id;
    }
    this.hudTimer = 0;
  }

  private clearSelection() {
    this.selected.clear();
    this.focus = -1;
    this.hudTimer = 0;
  }

  private moveTo(p: { x: number; z: number }, run: boolean) {
    const sel = this.ownSelected();
    if (sel.length === 0) return;
    const b = this.battle;
    let gx = 0;
    let gz = 0;
    let ofx = 0;
    let ofz = 0;
    for (const u of sel) {
      gx += u.cx;
      gz += u.cz;
      ofx += u.fx;
      ofz += u.fz;
    }
    gx /= sel.length;
    gz /= sel.length;
    const ol = Math.hypot(ofx, ofz) || 1;
    ofx /= ol;
    ofz /= ol;
    let nfx = ofx;
    let nfz = ofz;
    const dl = Math.hypot(p.x - gx, p.z - gz);
    if (dl > 6) {
      nfx = (p.x - gx) / dl;
      nfz = (p.z - gz) / dl;
    }
    const da = Math.atan2(nfx, nfz) - Math.atan2(ofx, ofz);
    const c = Math.cos(da);
    const s = Math.sin(da);
    for (const u of sel) {
      const ox = u.cx - gx;
      const oz = u.cz - gz;
      const rx = ox * c + oz * s;
      const rz = oz * c - ox * s;
      b.orderMove(u.id, p.x + rx, p.z + rz, nfx, nfz, run);
    }
  }

  private attack(target: number, run: boolean) {
    for (const u of this.ownSelected()) this.battle.orderAttack(u.id, target, run);
  }

  private planLine(sx: number, sz: number, ex: number, ez: number): PlanItem[] {
    const sel = this.ownSelected();
    if (sel.length === 0) return [];
    const L = Math.hypot(ex - sx, ez - sz);
    if (L < 2) return [];
    const dx = (ex - sx) / L;
    const dz = (ez - sz) / L;
    // Face away from the camera.
    const cf = this.cam.forward;
    let fx = -dz;
    let fz = dx;
    if (fx * cf.x + fz * cf.z < 0) {
      fx = -fx;
      fz = -fz;
    }
    sel.sort((a, b) => (a.mx - sx) * dx + (a.mz - sz) * dz - ((b.mx - sx) * dx + (b.mz - sz) * dz));
    const total = sel.reduce((a, u) => a + u.alive * u.def.spacing, 0);
    const gap = sel.length > 1 ? 3 : 0;
    const usable = Math.max(L - gap * (sel.length - 1), sel.length * 4);
    let cursor = 0;
    const out: PlanItem[] = [];
    for (const u of sel) {
      const seg = (usable * u.alive * u.def.spacing) / total;
      const files = this.battle.clampFiles(u, seg / u.def.spacing);
      const w = files * u.def.spacing;
      const d = Math.ceil(u.alive / files) * u.def.rankSpacing;
      const mid = cursor + seg / 2;
      out.push({ u, x: sx + dx * mid - fx * (d / 2), z: sz + dz * mid - fz * (d / 2), fx, fz, files, w, d });
      cursor += seg + gap;
    }
    return out;
  }

  private commitPlan(run: boolean) {
    for (const p of this.plan) this.battle.orderMove(p.u.id, p.x, p.z, p.fx, p.fz, run, p.files);
    this.plan = [];
  }

  private halt() {
    for (const u of this.ownSelected()) this.battle.orderHalt(u.id);
  }

  private selectAll() {
    this.selected.clear();
    for (const u of this.battle.units) if (u.side === this.player && u.active) this.selected.add(u.id);
    const first = [...this.selected][0];
    if (first !== undefined) this.focus = first;
    this.hudTimer = 0;
  }

  /** Ctrl+N stores the selection as group N; N selects it; pressing N twice centers on it. */
  private controlGroup(n: number, assign: boolean, t: number) {
    if (assign) {
      const ids = this.ownSelected().map((u) => u.id);
      if (ids.length === 0) return;
      this.groups.set(n, ids);
      this.toast(`Group ${n} set (${ids.length} unit${ids.length > 1 ? 's' : ''})`, 'info', 2);
      this.hudTimer = 0;
      return;
    }
    const ids = (this.groups.get(n) ?? []).filter((id) => this.battle.units[id]?.active);
    if (ids.length === 0) return;
    this.selected = new Set(ids);
    this.focus = ids[0];
    if (this.lastGroupKey.n === n && t - this.lastGroupKey.t < 400) this.centerOn(ids.map((id) => this.battle.units[id]));
    this.lastGroupKey = { n, t };
    this.hudTimer = 0;
  }

  private centerOn(units: Unit[]) {
    if (units.length === 0) return;
    let x = 0;
    let z = 0;
    for (const u of units) {
      x += u.mx;
      z += u.mz;
    }
    this.cam.tx = x / units.length;
    this.cam.tz = z / units.length;
  }

  // ------------------------------------------------------------------ input
  private bindInput() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => {
      this.ptrs.delete(e.pointerId);
      this.drag = null;
      this.plan = [];
      $('box').hidden = true;
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (this.suspended) return;
        e.preventDefault();
        this.cam.zoom(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (!this.battle || this.suspended) return;
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) {
        e.preventDefault();
        this.controlGroup(Number(digit[1]), e.ctrlKey || e.metaKey, e.timeStamp);
        return;
      }
      if (k === ' ') {
        e.preventDefault();
        this.togglePause();
      } else if (k === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.selectAll();
      } else if (k === 'h') this.halt();
      else if (k === 'r') this.setRun(!this.runMode);
      else if (k === 'l') this.setLine(!this.lineMode);
      else if (k === 'c') this.centerOn(this.ownSelected());
      else if (k === 'escape') this.clearSelection();
      else if (k === 'g') this.toggleGuard();
      else if (k === '+' || k === '=') this.setSpeed(Math.min(4, this.speed * 2));
      else if (k === '-') this.setSpeed(Math.max(0.5, this.speed / 2));
      else this.cam.keys.add(k);
    });
    window.addEventListener('keyup', (e) => this.cam.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.cam.keys.clear());
  }

  private onDown(e: PointerEvent) {
    if (!this.battle || this.suspended) return;
    this.canvas.setPointerCapture(e.pointerId);
    const now = performance.now();
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: now, button: e.button, type: e.pointerType });
    if (e.pointerType !== 'mouse') {
      if (this.ptrs.size >= 2) {
        const [a, b] = [...this.ptrs.values()];
        this.drag = { kind: 'pinch', moved: true, d: Math.hypot(a.x - b.x, a.y - b.y), a: Math.atan2(b.y - a.y, b.x - a.x), my: (a.y + b.y) / 2 };
        this.pinchLock = true;
        this.plan = [];
      } else {
        this.pinchLock = false;
        if (this.lineMode && this.ownSelected().length > 0) {
          const g = this.pickGround(e.clientX, e.clientY);
          this.drag = g ? { kind: 'line', moved: false, sx: g.x, sz: g.z, ex: g.x, ez: g.z, ok: true } : { kind: 'pan', moved: false };
        } else this.drag = { kind: 'pan', moved: false };
      }
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.altKey)) this.drag = { kind: 'rotate', moved: false };
    else if (e.button === 0) {
      if (this.lineMode && this.ownSelected().length > 0) {
        const g = this.pickGround(e.clientX, e.clientY);
        this.drag = g ? { kind: 'line', moved: false, sx: g.x, sz: g.z, ex: g.x, ez: g.z, ok: true } : { kind: 'box', moved: false };
      } else this.drag = { kind: 'box', moved: false };
    } else if (e.button === 2) {
      const g = this.pickGround(e.clientX, e.clientY);
      this.drag = { kind: 'line', moved: false, sx: g?.x ?? 0, sz: g?.z ?? 0, ex: g?.x ?? 0, ez: g?.z ?? 0, ok: !!g };
    }
  }

  private onMove(e: PointerEvent) {
    if (!this.battle || this.suspended) return;
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') {
        this.hover = this.pickUnit(e.clientX, e.clientY);
        const hu = this.hover >= 0 ? this.battle.units[this.hover] : null;
        const cur = hu && hu.side !== this.player && this.ownSelected().length > 0 ? 'crosshair' : hu ? 'pointer' : 'default';
        if (this.canvas.style.cursor !== cur) this.canvas.style.cursor = cur;
      }
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const d = this.drag;
    if (!d) return;
    const thr = p.type === 'mouse' ? 6 : 10;
    if (!d.moved && Math.hypot(p.x - p.sx, p.y - p.sy) > thr) d.moved = true;
    if (!d.moved) return;
    switch (d.kind) {
      case 'pan':
        this.cam.pan(dx, dy);
        break;
      case 'rotate':
        this.cam.rotate(-dx * 0.006, dy * 0.004);
        break;
      case 'box': {
        const bx = $('box');
        bx.hidden = false;
        bx.style.left = Math.min(p.x, p.sx) + 'px';
        bx.style.top = Math.min(p.y, p.sy) + 'px';
        bx.style.width = Math.abs(p.x - p.sx) + 'px';
        bx.style.height = Math.abs(p.y - p.sy) + 'px';
        break;
      }
      case 'line': {
        if (!d.ok) break;
        const g = this.pickGround(p.x, p.y);
        if (g) {
          d.ex = g.x;
          d.ez = g.z;
          this.plan = this.planLine(d.sx, d.sz, d.ex, d.ez);
        }
        break;
      }
      case 'pinch': {
        const [a, b] = [...this.ptrs.values()];
        if (!a || !b) break;
        const nd = Math.hypot(a.x - b.x, a.y - b.y);
        const na = Math.atan2(b.y - a.y, b.x - a.x);
        const my = (a.y + b.y) / 2;
        if (d.d > 0) this.cam.zoom(d.d / Math.max(10, nd));
        let da = na - d.a;
        if (da > Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        this.cam.rotate(da, (my - d.my) * 0.004);
        d.d = nd;
        d.a = na;
        d.my = my;
        break;
      }
    }
  }

  private onUp(e: PointerEvent) {
    if (!this.battle) return;
    const p = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);
    const d = this.drag;
    if (!p || !d) return;
    const touch = p.type !== 'mouse';
    const now = e.timeStamp; // event time, so slow frames don't break double clicks
    if (touch) {
      if (d.kind === 'pinch') {
        if (this.ptrs.size === 0) this.drag = null;
        return;
      }
      this.drag = null;
      if (this.pinchLock) return;
      if (d.kind === 'line' && d.moved && this.plan.length > 0) {
        this.commitPlan(this.runMode);
        return;
      }
      if (!d.moved) {
        const dbl = now - this.lastTap.t < 330 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30;
        this.lastTap = { t: now, x: p.x, y: p.y };
        this.tap(p.x, p.y, dbl);
      }
      this.plan = [];
      return;
    }
    this.drag = null;
    if (d.kind === 'box') {
      $('box').hidden = true;
      if (d.moved) this.boxSelect(p.sx, p.sy, p.x, p.y, e.shiftKey || e.ctrlKey);
      else {
        const id = this.pickUnit(p.x, p.y);
        const dbl = now - this.lastTap.t < 330 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 20;
        this.lastTap = { t: now, x: p.x, y: p.y };
        if (id >= 0) this.clickUnit(id, e.shiftKey || e.ctrlKey, false, dbl);
        else if (!e.shiftKey && !e.ctrlKey) this.clearSelection();
      }
    } else if (d.kind === 'line') {
      if (d.moved && this.plan.length > 0) this.commitPlan(this.runMode);
      else if (p.button === 2) this.rightClick(p.x, p.y, now);
      else if (!d.moved) this.tap(p.x, p.y, false);
      this.plan = [];
    }
  }

  private rightClick(x: number, y: number, now: number) {
    const dbl = now - this.lastRight.t < 350 && Math.hypot(x - this.lastRight.x, y - this.lastRight.y) < 24;
    this.lastRight = { t: now, x, y };
    const run = this.runMode || dbl;
    const id = this.pickUnit(x, y);
    if (id >= 0 && this.battle.units[id].side !== this.player) {
      this.attack(id, run);
      return;
    }
    const g = this.pickGround(x, y);
    if (g) this.moveTo(g, run);
  }

  private tap(x: number, y: number, dbl: boolean) {
    const id = this.pickUnit(x, y);
    if (id >= 0) {
      this.clickUnit(id, false, true, dbl);
      return;
    }
    if (this.ownSelected().length > 0) {
      const g = this.pickGround(x, y);
      if (g) this.moveTo(g, this.runMode || dbl);
    } else {
      this.focus = -1;
    }
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, add: boolean) {
    const r = this.canvas.getBoundingClientRect();
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    if (!add) {
      this.selected.clear();
      this.focus = -1;
    }
    const v = new THREE.Vector3();
    for (const u of this.battle.units) {
      if (u.side !== this.player || !u.active) continue;
      v.set(u.mx, u.my + 1, u.mz).project(this.view.camera);
      if (v.z > 1) continue;
      const sx = r.left + ((v.x + 1) / 2) * r.width;
      const sy = r.top + ((1 - v.y) / 2) * r.height;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        this.selected.add(u.id);
        this.focus = u.id;
      }
    }
    this.hudTimer = 0;
  }

  // ------------------------------------------------------------------ HUD
  private bindHud() {
    $('btnPause').onclick = () => this.togglePause();
    $('btnSpeed').onclick = () => this.setSpeed(this.speed >= 4 ? 1 : this.speed * 2);
    $('btnRun').onclick = () => this.setRun(!this.runMode);
    $('btnHalt').onclick = () => this.halt();
    $('btnLine').onclick = () => this.setLine(!this.lineMode);
    $('btnAll').onclick = () => this.selectAll();
    $('btnGuard').onclick = () => this.toggleGuard();
    $('btnCenter').onclick = () => this.centerOn(this.ownSelected().length ? this.ownSelected() : this.battle.units.filter((u) => u.side === this.player && u.active));
    $('btnFire').onclick = () => {
      const sel = this.ownSelected().filter((u) => u.def.missile);
      const on = !sel.every((u) => u.fireAtWill);
      for (const u of sel) {
        u.fireAtWill = on;
        if (!on) u.fireTarget = -1;
      }
      this.updateOrderButtons();
    };
    $('btnMenu').onclick = () => ($('menu').hidden = !$('menu').hidden);
    $('mRestart').onclick = () => {
      $('menu').hidden = true;
      this.start(this.settings);
    };
    $('mNew').onclick = () => {
      $('menu').hidden = true;
      $('start').hidden = false;
    };
    $('mHelp').onclick = () => {
      $('menu').hidden = true;
      $('help').hidden = false;
    };
    $('mAuto').onclick = () => {
      this.autoPlayer = !this.autoPlayer;
      this.ai[this.player] = this.autoPlayer ? new BattleAI(this.player, 0) : null;
      $('mAuto').textContent = this.autoPlayer ? 'AI commands my army: ON' : 'AI commands my army: OFF';
      $('menu').hidden = true;
    };
    $('helpClose').onclick = () => ($('help').hidden = true);
    $('endWatch').onclick = () => ($('end').hidden = true);
    $('endCampaign').onclick = () => this.finishCampaignBattle(false);
    $('mWithdraw').onclick = () => {
      $('menu').hidden = true;
      if (confirm('Withdraw from the battle? Your army retreats and the battle counts as lost.')) this.finishCampaignBattle(true);
    };
    $('endNew').onclick = () => {
      $('end').hidden = true;
      $('start').hidden = false;
    };
    $('endRestart').onclick = () => {
      $('end').hidden = true;
      this.start(this.settings);
    };
  }

  private togglePause() {
    if (!this.battle) return;
    if (!this.started) {
      this.started = true;
      this.paused = false;
      this.toast('The battle has begun!', 'info', 3);
    } else this.paused = !this.paused;
    this.updateTopBar();
  }

  private toggleGuard() {
    const sel = this.ownSelected();
    if (sel.length === 0) return;
    const on = !sel.every((u) => u.guard);
    for (const u of sel) u.guard = on;
    this.toast(on ? 'Guard mode on: holding formation' : 'Guard mode off: free to engage and chase', 'info', 2.5);
    this.updateOrderButtons();
    this.hudTimer = 0;
  }

  private setSpeed(s: number) {
    this.speed = s;
    this.updateTopBar();
  }

  private setRun(on: boolean) {
    this.runMode = on;
    // Apply to current orders of the selection too.
    for (const u of this.ownSelected()) if (u.order.kind !== 'none') u.order.run = on;
    this.updateOrderButtons();
  }

  private setLine(on: boolean) {
    this.lineMode = on;
    this.updateOrderButtons();
  }

  private updateTopBar() {
    const btn = $('btnPause');
    btn.textContent = !this.started ? '▶ Start battle' : this.paused ? '▶ Resume' : '❚❚ Pause';
    btn.classList.toggle('primary', !this.started || this.paused);
    $('btnSpeed').textContent = `${this.speed}×`;
    if (this.battle) {
      const t = Math.floor(this.battle.time);
      $('clock').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      const mine = this.battle.sideStats(this.player);
      const theirs = this.battle.sideStats(this.enemy);
      $('tally').innerHTML = `<span class="own">${mine.alive}</span> vs <span class="foe">${theirs.alive}</span>`;
    }
  }

  private updateOrderButtons() {
    $('btnRun').classList.toggle('on', this.runMode);
    $('btnLine').classList.toggle('on', this.lineMode);
    const own = this.battle ? this.ownSelected() : [];
    $('btnGuard').classList.toggle('on', own.length > 0 && own.every((u) => u.guard));
    ($('btnGuard') as HTMLButtonElement).disabled = own.length === 0;
    const missiles = own.filter((u) => u.def.missile);
    const fire = $('btnFire');
    fire.hidden = missiles.length === 0;
    fire.classList.toggle('on', missiles.length > 0 && missiles.every((u) => u.fireAtWill));
  }

  private buildBanners() {
    const host = $('banners');
    host.innerHTML = '';
    this.banners = [];
    for (const u of this.battle.units) {
      const el = document.createElement('div');
      el.className = `banner ${u.side === this.player ? 'own' : 'foe'}`;
      el.innerHTML = `<div class="cloth" style="--fc:#${u.faction.primary.toString(16).padStart(6, '0')}">${ICONS[u.def.visual]}</div><div class="mbar"><i></i></div><div class="pole"></div>`;
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.title = `${u.def.name} (${u.faction.name})`;
      el.addEventListener('click', (e) => {
        this.clickUnit(u.id, e.shiftKey || e.ctrlKey, false, e.detail >= 2);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (u.side !== this.player) this.attack(u.id, this.runMode);
      });
      host.appendChild(el);
      this.banners.push(el);
    }
  }

  private updateBanners() {
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    const cam = this.view.camera;
    for (const u of this.battle.units) {
      const el = this.banners[u.id];
      if (u.gone || u.alive === 0) {
        el.style.display = 'none';
        continue;
      }
      v.set(u.mx, u.my + (u.def.mounted ? 9 : 7.5), u.mz);
      const dist = v.distanceTo(cam.position);
      v.project(cam);
      if (v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      const sx = r.left + ((v.x + 1) / 2) * r.width;
      const sy = r.top + ((1 - v.y) / 2) * r.height;
      const sc = Math.max(0.55, Math.min(1.1, 170 / dist));
      el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%) scale(${sc.toFixed(3)})`;
      const breaking = u.state === 'wavering' || (u.state === 'ok' && u.morale < 40);
      const cls = `banner ${u.side === this.player ? 'own' : 'foe'} st-${u.state}${breaking ? ' breaking' : ''}${this.selected.has(u.id) ? ' sel' : ''}${this.focus === u.id ? ' focus' : ''}${this.hover === u.id ? ' hover' : ''}`;
      if (el.className !== cls) el.className = cls;
      const bar = el.querySelector('.mbar i') as HTMLElement;
      const w = `${Math.max(0, Math.min(100, u.morale)).toFixed(0)}%`;
      if (bar.style.width !== w) {
        bar.style.width = w;
        bar.style.background = u.morale >= 50 ? '#8fd16a' : u.morale >= 32 ? '#e0b43c' : '#e0503f';
      }
    }
  }

  private buildCards() {
    const host = $('cards');
    host.innerHTML = '';
    this.cards.clear();
    for (const u of this.battle.units) {
      if (u.side !== this.player) continue;
      const el = document.createElement('div');
      el.className = 'card';
      const key = `${u.def.model ?? u.def.visual}|${u.faction.id}`;
      if (!this.portraits.has(key)) this.portraits.set(key, this.view.portrait(u));
      const img = this.portraits.get(key);
      el.innerHTML = `<div class="pic">${img ? `<img src="${img}" alt="">` : ICONS[u.def.visual]}</div><div class="ic">${ICONS[u.def.visual]}</div><div class="grp"></div><div class="nm">${u.def.name}</div><div class="cnt"></div><div class="bar mor"><i></i></div><div class="bar en"><i></i></div><div class="st"></div>`;
      el.onclick = (e) => {
        const dbl = e.detail >= 2;
        if (!u.active) {
          this.focus = u.id;
          this.hudTimer = 0;
          return;
        }
        this.clickUnit(u.id, e.shiftKey || e.ctrlKey, false, dbl);
      };
      host.appendChild(el);
      this.cards.set(u.id, el);
    }
  }

  private updateCards() {
    for (const [id, el] of this.cards) {
      const u = this.battle.units[id];
      (el.querySelector('.cnt') as HTMLElement).textContent = `${u.alive}`;
      const m = el.querySelector('.mor i') as HTMLElement;
      m.style.width = `${Math.max(0, Math.min(100, u.morale))}%`;
      m.style.background = u.morale >= 50 ? '#7fc35a' : u.morale >= 35 ? '#e0b43c' : '#d9503f';
      (el.querySelector('.en i') as HTMLElement).style.width = `${u.energy}%`;
      const st = el.querySelector('.st') as HTMLElement;
      st.textContent = stateLabel(u);
      let grp = '';
      for (const [n, ids] of this.groups) if (ids.includes(id)) grp = String(n);
      (el.querySelector('.grp') as HTMLElement).textContent = grp;
      el.className = `card st-${u.state}${this.selected.has(id) ? ' sel' : ''}${u.inMelee > 0 ? ' melee' : ''}`;
    }
    this.updateOrderButtons();
  }

  private updateInfo() {
    const box = $('info');
    const u = this.focus >= 0 ? this.battle.units[this.focus] : null;
    if (!u) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const fat = fatigueLevel(u.energy);
    const mods = [...u.mods].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    if (u.shock >= 1) mods.push({ label: 'Shock', value: -Math.round(u.shock) });
    const d = u.def;
    const own = u.side === this.player;
    const order =
      u.routing ? 'Fleeing' : u.order.kind === 'attack' ? `Attacking ${this.battle.units[u.order.target]?.def.name ?? ''}` : u.order.kind === 'move' ? (u.running ? 'Running' : 'Marching') : u.inMelee > 0 ? 'Fighting' : u.def.missile && u.fireTarget >= 0 ? 'Shooting' : 'Holding';
    box.innerHTML = `
      <div class="ih ${own ? 'own' : 'foe'}"><span class="ic">${ICONS[d.visual]}</span><div><b>${d.name}</b><small>${u.faction.name}${own ? '' : ' (enemy)'}</small></div></div>
      <div class="row"><span>Men</span><b>${u.alive} / ${u.startMen}</b><span>Kills</span><b>${u.kills}</b><span>Leadership</span><b>${d.morale}</b></div>
      <div class="stats"><span>Atk <b>${d.attack}</b></span><span>Chg <b>${d.charge}</b></span><span>Def <b>${d.defense}</b></span><span>Arm <b>${d.armor}</b></span><span>Shd <b>${d.shield}</b></span>${d.bonusVsCav ? `<span>vs Cav <b>+${d.bonusVsCav}</b></span>` : ''}${d.missile ? `<span>Ammo <b>${this.battle.ammoLeft(u)}</b></span>` : ''}</div>
      <div class="row"><span>${order}</span>${own ? `<span class="tag ${u.guard ? 'on' : ''}">${u.guard ? 'Guard' : 'Free'}</span>` : ''}</div>
      ${this.heightLine(u)}
      <div class="row"><span>Stamina</span><b>${fat.name}</b><span>Morale</span><b class="m-${u.state}">${Math.round(u.morale)} ${moraleLabel(u)}</b></div>
      <div class="mods">${mods.map((m) => `<div class="${m.value >= 0 ? 'pos' : 'neg'}"><span>${m.label}</span><b>${m.value > 0 ? '+' : ''}${m.value}</b></div>`).join('')}</div>`;
  }

  /** How this unit's ground compares with the nearest enemy unit. */
  private heightLine(u: Unit): string {
    let best: Unit | null = null;
    let bd = 1e9;
    for (const e of this.battle.units) {
      if (e.side === u.side || !e.active) continue;
      const d = Math.hypot(e.mx - u.mx, e.mz - u.mz);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (!best) return '';
    const dh = u.my - best.my;
    const cls = dh > 2 ? 'pos' : dh < -2 ? 'neg' : '';
    const what = dh > 2 ? 'Higher ground: +attack, +morale, +range' : dh < -2 ? 'Lower ground: enemy has the advantage' : 'Level ground';
    return `<div class="row height ${cls}"><span>${Math.abs(dh).toFixed(0)} m ${dh >= 0 ? 'above' : 'below'} ${best.def.name}</span></div><div class="row height ${cls}"><span>${what}</span></div>`;
  }

  private processEvents() {
    const ev = this.battle.events;
    while (this.evIdx < ev.length) {
      const e = ev[this.evIdx++];
      if (e.kind === 'charge') continue;
      const own = e.side === this.player;
      if (e.kind === 'victory') continue;
      const prefix = e.kind === 'general' ? '' : own ? 'Your ' : 'Enemy ';
      const kind = e.kind === 'rally' ? (own ? 'good' : 'bad') : e.kind === 'general' ? (own ? 'bad' : 'good') : own ? 'bad' : 'good';
      this.toast(prefix + e.text, kind, 4);
    }
  }

  toast(text: string, kind: 'info' | 'good' | 'bad', secs: number) {
    const host = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    host.appendChild(el);
    while (host.children.length > 4) host.removeChild(host.firstChild!);
    setTimeout(() => el.classList.add('out'), secs * 1000);
    setTimeout(() => el.remove(), secs * 1000 + 600);
  }

  /** Shows or hides the controls that only make sense in custom battles. */
  private campaignMode(on: boolean) {
    for (const id of ['mRestart', 'mNew', 'endRestart', 'endNew']) $(id).hidden = on;
    $('mWithdraw').hidden = !on;
    $('endCampaign').hidden = !on;
  }

  private finishCampaignBattle(withdrew: boolean) {
    const camp = this.settings.campaign;
    if (!camp) return;
    $('end').hidden = true;
    this.paused = true;
    camp.onEnd(this.battle, withdrew);
  }

  /** Hides the battle and its HUD while another screen uses the canvas. */
  suspend(on: boolean) {
    this.suspended = on;
    for (const id of ['topbar', 'bottom', 'banners', 'toasts']) $(id).hidden = on;
    for (const id of ['info', 'menu', 'end']) if (on) $(id).hidden = true;
    if (!on) this.resize();
  }

  private showEnd() {
    this.endShown = true;
    const b = this.battle;
    const won = b.result!.winner === this.player;
    const mine = b.sideStats(this.player);
    const theirs = b.sideStats(this.enemy);
    const ratio = (theirs.dead + 1) / (mine.dead + 1);
    const grade = won ? (ratio > 3 ? 'Heroic Victory' : ratio > 1.3 ? 'Clear Victory' : 'Close Victory') : ratio < 0.33 ? 'Crushing Defeat' : ratio < 0.8 ? 'Clear Defeat' : 'Narrow Defeat';
    $('endTitle').textContent = grade;
    $('endTitle').className = won ? 'win' : 'lose';
    const t = Math.floor(b.result!.time);
    $('endBody').innerHTML = `
      <p>Battle lasted ${Math.floor(t / 60)}m ${t % 60}s</p>
      <table><tr><th></th><th>${b.sides[this.player].faction.name}</th><th>${b.sides[this.enemy].faction.name}</th></tr>
      <tr><td>Started with</td><td>${mine.start}</td><td>${theirs.start}</td></tr>
      <tr><td>Killed</td><td>${mine.dead}</td><td>${theirs.dead}</td></tr>
      <tr><td>Fled the field</td><td>${mine.fled}</td><td>${theirs.fled}</td></tr>
      <tr><td>Still standing</td><td>${mine.alive}</td><td>${theirs.alive}</td></tr></table>`;
    $('end').hidden = false;
  }

  // ------------------------------------------------------------------ overlay
  private updateTints() {
    const v = this.view;
    for (const u of this.battle.units) {
      if (this.selected.has(u.id)) v.setUnitTint(u, 1.45, 1.38, 0.9);
      else if (u.id === this.focus || u.id === this.hover) v.setUnitTint(u, u.side === this.player ? 1.2 : 1.45, u.side === this.player ? 1.2 : 0.9, u.side === this.player ? 1.2 : 0.85);
      else v.setUnitTint(u, 1, 1, 1);
    }
  }

  /** Terrain-aware firing range: shooting downhill reaches further. */
  private rangeRing(u: Unit) {
    const m = u.def.missile!;
    const t = this.battle.terrain;
    const pts: number[] = [];
    const n = 64;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      let r = m.range;
      for (let it = 0; it < 3; it++) {
        const h = t.height(u.mx + dx * r, u.mz + dz * r);
        r = m.range * (1 + Math.max(-0.15, Math.min(0.3, (u.my - h) / 50)));
      }
      const x = u.mx + dx * r;
      const z = u.mz + dz * r;
      pts.push(x, t.height(x, z) + 0.6, z);
    }
    this.view.polyline(pts, 'range');
  }

  private drawOverlay() {
    const v = this.view;
    v.beginOverlay();
    v.beginGhosts();
    const buf = this.ghostBuf;
    const ghostsFor = (u: Unit, x: number, z: number, fx: number, fz: number, files: number, r: number, g: number, bl: number) => {
      const n = this.battle.formationPreview(u, x, z, fx, fz, files, buf);
      for (let k = 0; k < n; k++) v.ghost(buf[k * 2], buf[k * 2 + 1], r, g, bl);
    };
    for (const id of this.selected) {
      const u = this.battle.units[id];
      if (!u || u.alive === 0) continue;
      v.rect(u.cx, u.cz, u.fx, u.fz, u.width + 1, u.depth + 1, 'sel');
      if (u.order.kind === 'move') {
        v.path(u.mx, u.mz, u.order.x, u.order.z, 'move');
        const files = Math.min(u.files, u.alive);
        v.rect(u.order.x, u.order.z, u.order.fx, u.order.fz, files * u.def.spacing, Math.ceil(u.alive / files) * u.def.rankSpacing, 'move');
        if (this.plan.length === 0) ghostsFor(u, u.order.x, u.order.z, u.order.fx, u.order.fz, u.files, 0.55, 0.95, 0.45);
      } else if (u.order.kind === 'attack') {
        const t = this.battle.units[u.order.target];
        if (t && t.alive > 0) v.path(u.mx, u.mz, t.mx, t.mz, 'attack');
      }
    }
    for (const id of this.selected) {
      const u = this.battle.units[id];
      if (u && u.def.missile && u.alive > 0) this.rangeRing(u);
    }
    for (const id of [this.focus, this.hover]) {
      if (id < 0) continue;
      const u = this.battle.units[id];
      if (!u || u.alive === 0 || this.selected.has(id)) continue;
      v.rect(u.mx, u.mz, u.fx, u.fz, u.width + 1, u.depth + 1, u.side === this.player ? 'own' : 'enemy');
    }
    for (const p of this.plan) {
      v.rect(p.x, p.z, p.fx, p.fz, p.w, p.d, 'plan');
      v.path(p.u.mx, p.u.mz, p.x, p.z, 'plan');
      ghostsFor(p.u, p.x, p.z, p.fx, p.fz, p.files, 1, 1, 1);
    }
    v.endOverlay();
    v.endGhosts();
  }
}

function moraleLabel(u: Unit): string {
  if (u.state === 'ok') return u.morale >= 70 ? 'Eager' : u.morale >= 50 ? 'Steady' : 'Shaken';
  return stateLabel(u);
}

function stateLabel(u: Unit): string {
  switch (u.state) {
    case 'ok':
      return u.inMelee > 0 ? 'Fighting' : u.rallied ? 'Rallied' : 'Steady';
    case 'wavering':
      return 'Wavering';
    case 'routing':
      return 'Routing';
    case 'shattered':
      return 'Shattered';
    case 'destroyed':
      return 'Destroyed';
    case 'fled':
      return 'Fled';
  }
}
