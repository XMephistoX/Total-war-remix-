// Campaign screen: map input, HUD panels, turn flow and the hand-off to real-time battles.

import { UNITS } from '../sim/data';
import type { FactionDef, UnitSize } from '../sim/data';
import type { Battle } from '../sim/battle';
import type { Game } from '../ui/game';
import { RtsCamera } from '../ui/camera';
import { loadUnitAsset } from '../render/crowd';
import type { UnitAsset } from '../render/crowd';
import { MapData } from './map';
import { Campaign } from './state';
import type { Army, BattleOutcome, PendingBattle, Settlement, Target } from './state';
import { CampaignView, ARMY_MODEL, HS } from './view';
import { aiTurn, acceptsPeace } from './ai';
import { CHAINS, LEVEL_NAMES, MAX_UNITS, TAX_NAMES, settlementLevel, unitStrength, upkeep } from './rules';
import type { Chain, Tax } from './rules';
import WORLD from './world.json';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const SAVE_KEY = 'twr-campaign-save';

export function hasSave(): boolean {
  try {
    return !!localStorage.getItem(SAVE_KEY);
  } catch {
    return false;
  }
}

export class CampaignUI {
  private readonly game: Game;
  private map: MapData | null = null;
  private assets = new Map<string, UnitAsset>();
  c!: Campaign;
  view!: CampaignView;
  cam!: RtsCamera;
  active = false;
  size: UnitSize = 'large';
  private selArmy: number | null = null;
  private selSettlement: string | null = null;
  private selUnits = new Set<number>();
  private tab: 'build' | 'recruit' = 'recruit';
  private busy = false;
  private down: { x: number; y: number; button: number; moved: boolean; t: number } | null = null;
  private lastT = 0;
  private hoverPt: { x: number; y: number } | null = null;
  private previewAt = 0;
  private labels = new Map<string, HTMLElement>();
  private running = false;

  constructor(game: Game) {
    this.game = game;
    this.bindInput();
  }

  // ------------------------------------------------------------------ open / close
  async open(faction: string | null, load = false) {
    $('loading').hidden = false;
    $('loading').querySelector('p')!.textContent = 'Drawing the map of the known world.';
    if (!this.map) {
      this.map = await MapData.load();
      this.map.initSearch();
    }
    const models = [...new Set(Object.values(ARMY_MODEL))];
    const loaded = await Promise.all(models.map((m) => loadUnitAsset(m)));
    models.forEach((m, i) => {
      const a = loaded[i];
      if (a) this.assets.set(m, a);
    });
    this.c = new Campaign(this.map);
    if (load) {
      try {
        this.c.load(localStorage.getItem(SAVE_KEY) ?? '');
      } catch {
        this.c.newGame(faction ?? 'rome');
      }
    } else this.c.newGame(faction ?? 'rome');
    this.c.onBattle = (b) => this.battlePrompt(b);
    this.c.onEvent = (title, text) => this.message(title, text);
    if (this.view) this.view.dispose();
    this.view = new CampaignView(this.game.renderer, this.c, this.assets);
    const ground = { height: (x: number, z: number) => this.view.ground(x, z) };
    this.cam = new RtsCamera(this.view.camera, ground, { x: this.map.W / 2, z: this.map.H / 2, minDist: 18, maxDist: 900 });
    const cap = this.c.faction(this.c.player).capital;
    const s = cap ? this.c.settlement(cap) : this.c.settlements.find((x) => x.owner === this.c.player);
    if (s) this.cam.jump(s.x - this.map.W / 2, s.y - this.map.H / 2, 0, 150, 0.95);
    this.selArmy = null;
    this.selSettlement = null;
    this.buildLabels();
    $('loading').hidden = true;
    this.game.suspend(true);
    $('start').hidden = true;
    $('campaign').hidden = false;
    this.active = true;
    this.resize();
    this.refresh();
    if (!load) {
      const f = this.c.faction(this.c.player);
      await this.message(`${f.name}, ${this.c.yearName()}`, intro(f.id));
    }
    if (!this.running) {
      this.running = true;
      this.lastT = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  close() {
    this.active = false;
    $('campaign').hidden = true;
    $('start').hidden = false;
    this.game.suspend(false);
  }

  private resize() {
    if (!this.view) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.game.renderer.setSize(w, h, false);
    this.view.resize(w, h);
  }

  // ------------------------------------------------------------------ main loop
  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (!this.active) return;
    this.cam.update(dt);
    this.view.update(dt);
    this.updateSelectionMarks();
    this.view.render();
    this.updateLabels();
  }

  // ------------------------------------------------------------------ input
  private bindInput() {
    const cv = this.game.canvas;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this.down = { x: e.clientX, y: e.clientY, button: e.button, moved: false, t: performance.now() };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.active) return;
      const d = this.down;
      if (d) {
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) > 5) d.moved = true;
        if (d.moved) {
          if (d.button === 0) this.cam.pan(dx, dy);
          else if (d.button === 1) this.cam.rotate(-dx * 0.005, dy * 0.004);
          d.x = e.clientX;
          d.y = e.clientY;
        }
        return;
      }
      this.hoverPt = this.view.pick(e.clientX, e.clientY);
      this.hoverMove(e.clientX, e.clientY);
    });
    cv.addEventListener('pointerup', (e) => {
      if (!this.active || !this.down) return;
      const d = this.down;
      this.down = null;
      if (d.moved) return;
      if (d.button === 0) this.leftClick(e.clientX, e.clientY);
      else if (d.button === 2) void this.rightClick(e.clientX, e.clientY);
    });
    cv.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.cam.zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!this.active || (e.target as HTMLElement).tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'enter') void this.endTurn();
      else if (k === 'escape') this.deselect();
      else if (k === 'p') {
        this.view.political = !this.view.political;
        $('cPolitical').classList.toggle('on', this.view.political);
      } else this.cam.keys.add(k);
    });
    window.addEventListener('keyup', (e) => this.cam?.keys.delete(e.key.toLowerCase()));
    window.addEventListener('resize', () => this.active && this.resize());
  }

  private armyAtScreen(sx: number, sy: number): Army | null {
    let best: Army | null = null;
    let bd = 26;
    for (const a of this.c.armies) {
      if (a.inside) continue;
      const p = this.view.armyPos(a);
      const pr = this.view.project(p.x, p.y, 3);
      if (!pr.vis) continue;
      const d = Math.hypot(pr.sx - sx, pr.sy - sy);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  private settlementAtScreen(sx: number, sy: number): Settlement | null {
    let best: Settlement | null = null;
    let bd = 30;
    for (const s of this.c.settlements) {
      const pr = this.view.project(s.x, s.y, 1);
      if (!pr.vis) continue;
      const d = Math.hypot(pr.sx - sx, pr.sy - sy);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  private leftClick(sx: number, sy: number) {
    const a = this.armyAtScreen(sx, sy);
    if (a) return this.selectArmy(a.id);
    const s = this.settlementAtScreen(sx, sy);
    if (s) return this.selectSettlement(s.id);
    this.deselect();
  }

  private targetAt(sx: number, sy: number): Target | null {
    const a = this.armyAtScreen(sx, sy);
    if (a && a.id !== this.selArmy) return { kind: 'army', id: a.id };
    const s = this.settlementAtScreen(sx, sy);
    if (s) return { kind: 'settlement', id: s.id };
    const p = this.view.pick(sx, sy);
    return p ? { kind: 'point', x: p.x, y: p.y } : null;
  }

  private async rightClick(sx: number, sy: number) {
    const a = this.selArmy !== null ? this.c.army(this.selArmy) : null;
    if (!a || a.owner !== this.c.player || this.busy) return;
    const t = this.targetAt(sx, sy);
    if (!t) return;
    if (t.kind === 'settlement' && a.inside === t.id) return;
    // Split first if some units of the army are selected.
    let mover = a;
    if (this.selUnits.size && this.selUnits.size < a.units.length) {
      const b = this.c.split(a, [...this.selUnits]);
      if (b) mover = b;
    }
    this.selUnits.clear();
    if (t.kind === 'army') {
      const o = this.c.army(t.id)!;
      if (o.owner !== this.c.player && !this.c.atWar(this.c.player, o.owner) && !(await this.confirmWar(o.owner))) return;
    } else if (t.kind === 'settlement') {
      const s = this.c.settlement(t.id)!;
      if (s.owner !== this.c.player && !this.c.atWar(this.c.player, s.owner) && !(await this.confirmWar(s.owner))) return;
    }
    this.busy = true;
    try {
      await this.c.order(mover, t);
    } finally {
      this.busy = false;
    }
    this.selArmy = this.c.army(mover.id) ? mover.id : null;
    this.view.updateOwners();
    this.refresh();
  }

  private async confirmWar(fid: string): Promise<boolean> {
    const f = this.c.faction(fid);
    return this.ask('Declare war?', `Attacking ${f.name} means war with them.`, ['Declare war', 'Cancel']).then((i) => i === 0);
  }

  private hoverMove(sx: number, sy: number) {
    const a = this.selArmy !== null ? this.c.army(this.selArmy) : null;
    const tip = $('cTip');
    const hs = this.settlementAtScreen(sx, sy);
    const ha = this.armyAtScreen(sx, sy);
    this.view.setProvinceHighlight(this.hoverPt ? this.c.map.provinceAt(this.hoverPt.x, this.hoverPt.y) : -1, this.selSettlement ? this.c.settlement(this.selSettlement)!.idx : -1);
    let text = '';
    if (ha) {
      const f = this.c.faction(ha.owner);
      text = `<b>${f.name}</b>: ${ha.name}, ${ha.units.length} units, ${fmt(this.c.armyMen(ha))} men`;
    } else if (hs) {
      const f = this.c.faction(hs.owner);
      text = `<b>${hs.name}</b> (${hs.prov}): ${f.name}, ${LEVEL_NAMES[settlementLevel(hs.pop)]}, pop. ${fmt(hs.pop)}`;
    } else if (this.hoverPt) {
      const p = this.c.map.provinceAt(this.hoverPt.x, this.hoverPt.y);
      if (p >= 0) {
        const s = this.c.settlements[p];
        text = `${s.prov} (${this.c.faction(s.owner).name})`;
      }
    }
    // Path preview for the selected army.
    if (a && a.owner === this.c.player && this.hoverPt && performance.now() - this.previewAt > 90) {
      this.previewAt = performance.now();
      const t = this.targetAt(sx, sy);
      let tx = this.hoverPt.x;
      let ty = this.hoverPt.y;
      if (t?.kind === 'army') {
        const o = this.c.army(t.id)!;
        tx = o.x;
        ty = o.y;
      } else if (t?.kind === 'settlement') {
        const s = this.c.settlement(t.id)!;
        tx = s.x;
        ty = s.y;
        if (this.c.canSail(a, s) && !this.c.map.landConnected(a.x, a.y, s.x, s.y)) {
          this.view.showPath([{ x: a.x, y: a.y }, { x: s.x, y: s.y }], 2);
          text += `<br>⚓ Sail here (whole turn)`;
          tip.innerHTML = text;
          tip.style.left = `${sx + 16}px`;
          tip.style.top = `${sy + 14}px`;
          tip.hidden = !text;
          return;
        }
      }
      const p = this.c.plan(a, tx, ty);
      if (p && p.path.length) {
        const total = p.cost[p.cost.length - 1];
        let split = p.cost.findIndex((c) => c > a.mp);
        if (split < 0) split = p.path.length;
        const turns = total <= a.mp ? 0 : Math.ceil((total - a.mp) / this.c.maxMoves(a));
        this.view.showPath([{ x: a.x, y: a.y }, ...p.path], split + 1);
        text += `${text ? '<br>' : ''}${turns === 0 ? 'Reach this turn' : `${turns} more turn${turns > 1 ? 's' : ''}`}`;
      } else this.view.showPath(null);
    } else if (!a) this.view.showPath(null);
    tip.innerHTML = text;
    tip.style.left = `${sx + 16}px`;
    tip.style.top = `${sy + 14}px`;
    tip.hidden = !text;
  }

  // ------------------------------------------------------------------ selection
  private selectArmy(id: number) {
    this.selArmy = id;
    this.selSettlement = null;
    this.selUnits.clear();
    this.refresh();
  }

  private selectSettlement(id: string) {
    this.selSettlement = id;
    this.selArmy = null;
    this.selUnits.clear();
    this.view.showPath(null);
    this.refresh();
  }

  private deselect() {
    this.selArmy = null;
    this.selSettlement = null;
    this.selUnits.clear();
    this.view.showPath(null);
    this.refresh();
  }

  private updateSelectionMarks() {
    const a = this.selArmy !== null ? this.c.army(this.selArmy) : null;
    if (this.selArmy !== null && !a) this.selArmy = null;
    if (a) {
      const p = a.inside ? this.c.settlement(a.inside)! : this.view.armyPos(a);
      this.view.select(p.x, p.y, a.inside ? 6 : 3.4);
    } else if (this.selSettlement) {
      const s = this.c.settlement(this.selSettlement)!;
      this.view.select(s.x, s.y, 2 + settlementLevel(s.pop) * 0.6);
    } else this.view.select(null);
  }

  // ------------------------------------------------------------------ labels
  private buildLabels() {
    const host = $('cLabels');
    host.innerHTML = '';
    this.labels.clear();
  }

  private label(key: string, make: () => HTMLElement): HTMLElement {
    let el = this.labels.get(key);
    if (!el) {
      el = make();
      $('cLabels').appendChild(el);
      this.labels.set(key, el);
    }
    return el;
  }

  private updateLabels() {
    const used = new Set<string>();
    const camD = this.cam.dist;
    for (const s of this.c.settlements) {
      const key = `s${s.id}`;
      used.add(key);
      const el = this.label(key, () => {
        const d = document.createElement('div');
        d.className = 'clabel';
        d.addEventListener('pointerdown', (e) => e.stopPropagation());
        d.addEventListener('click', () => this.selectSettlement(s.id));
        d.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const p = this.view.project(s.x, s.y, 1);
          void this.rightClick(p.sx, p.sy);
        });
        return d;
      });
      const pr = this.view.project(s.x, s.y, 2.5 + settlementLevel(s.pop) * 0.4);
      const lvl = settlementLevel(s.pop);
      const show = pr.vis && (camD < 380 || lvl >= 3 || s.capital) && pr.dist < 1400;
      el.hidden = !show;
      if (!show) continue;
      const f = this.c.faction(s.owner);
      const g = this.c.garrison(s).reduce((t, a) => t + a.units.length, 0);
      const html = `<i style="background:${f.color}"></i>${s.capital ? '★ ' : ''}${s.name}${g ? `<small>${g}</small>` : ''}`;
      if (el.dataset.h !== html) {
        el.innerHTML = html;
        el.dataset.h = html;
      }
      el.classList.toggle('sel', this.selSettlement === s.id);
      el.classList.toggle('mine', s.owner === this.c.player);
      el.style.transform = `translate(${pr.sx}px, ${pr.sy}px) translate(-50%, -100%)`;
    }
    for (const a of this.c.armies) {
      if (a.inside) continue;
      const key = `a${a.id}`;
      used.add(key);
      const el = this.label(key, () => {
        const d = document.createElement('div');
        d.className = 'aflag';
        d.addEventListener('pointerdown', (e) => e.stopPropagation());
        d.addEventListener('click', () => this.selectArmy(a.id));
        d.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const p = this.view.armyPos(a);
          const q = this.view.project(p.x, p.y, 3);
          void this.rightClick(q.sx, q.sy);
        });
        return d;
      });
      const p = this.view.armyPos(a);
      const pr = this.view.project(p.x, p.y, 10.5);
      el.hidden = !pr.vis || pr.dist > 1500;
      if (el.hidden) continue;
      const f = this.c.faction(a.owner);
      const html = `<div class="cl" style="background:${f.color};border-color:${f.trim}">${a.units.length}</div>`;
      if (el.dataset.h !== html) {
        el.innerHTML = html;
        el.dataset.h = html;
      }
      el.classList.toggle('sel', this.selArmy === a.id);
      el.classList.toggle('mine', a.owner === this.c.player);
      el.classList.toggle('spent', a.owner === this.c.player && a.mp < 1);
      el.style.transform = `translate(${pr.sx}px, ${pr.sy}px) translate(-50%, -100%)`;
    }
    for (const [k, el] of this.labels) {
      if (!used.has(k)) {
        el.remove();
        this.labels.delete(k);
      }
    }
  }

  // ------------------------------------------------------------------ HUD
  refresh() {
    if (!this.c) return;
    const f = this.c.faction(this.c.player);
    const inc = this.c.incomeOf(f.id);
    $('cFaction').innerHTML = `<i style="background:${f.color};border-color:${f.trim}"></i>${f.name}`;
    $('cMoney').innerHTML = `<b>${fmt(f.treasury)}</b> denarii <span class="${inc.net >= 0 ? 'pos' : 'neg'}">${inc.net >= 0 ? '+' : ''}${fmt(inc.net)}/turn</span>`;
    $('cDate').textContent = this.c.yearName();
    $('cEnd').toggleAttribute('disabled', this.busy);
    this.renderLog();
    this.renderPanel();
  }

  private renderLog() {
    const host = $('cLog');
    const items = this.c.log.slice(-6).reverse();
    host.innerHTML = items.map((l, i) => `<div class="l ${l.kind}" data-i="${i}">${l.text}</div>`).join('');
    host.querySelectorAll<HTMLElement>('.l').forEach((el) => {
      const l = items[Number(el.dataset.i)];
      if (l.x !== undefined) {
        el.classList.add('go');
        el.onclick = () => this.cam.jump(l.x! - this.c.map.W / 2, l.y! - this.c.map.H / 2, this.cam.yaw, Math.min(this.cam.dist, 160), this.cam.pitch);
      }
    });
  }

  private renderPanel() {
    const p = $('cPanel');
    const a = (this.selArmy !== null ? this.c.army(this.selArmy) : null) ?? null;
    const s = (this.selSettlement ? this.c.settlement(this.selSettlement) : null) ?? null;
    if (a) p.innerHTML = this.armyPanel(a);
    else if (s) p.innerHTML = this.settlementPanel(s);
    else p.innerHTML = `<div class="hint">Left click a town or army to select it. Right click to move or attack. Left drag pans, wheel zooms, Q/E rotate. <b>P</b> shows the political map, <b>Enter</b> ends the turn.</div>`;
    p.hidden = false;
    this.bindPanel(a, s);
  }

  private unitCard(u: { unit: string; men: number; xp: number }, i: number, sel: boolean, extra = ''): string {
    const d = UNITS[u.unit];
    const full = d?.men ?? 100;
    const pct = Math.max(0, Math.min(100, (u.men / full) * 100));
    const chev = u.xp > 0 ? `<span class="xp">${'▲'.repeat(Math.min(3, Math.ceil(u.xp / 3)))}</span>` : '';
    return `<div class="cu ${sel ? 'on' : ''}" data-u="${i}" title="${d?.name ?? u.unit}: ${u.men} men, upkeep ${upkeep(u.unit)}">
      <div class="n">${d?.name ?? u.unit}</div>${chev}
      <div class="m">${u.men}</div><div class="bar"><i style="width:${pct}%"></i></div>${extra}</div>`;
  }

  private armyPanel(a: Army): string {
    const f = this.c.faction(a.owner);
    const mine = a.owner === this.c.player;
    const where = a.inside ? ` in ${this.c.settlement(a.inside)!.name}` : '';
    const mp = Math.max(0, Math.min(100, (a.mp / this.c.maxMoves(a)) * 100));
    const units = mine
      ? a.units.map((u, i) => this.unitCard(u, i, this.selUnits.has(i))).join('')
      : `<div class="hint">${a.units.length} units, about ${fmt(this.c.armyMen(a))} men. Strength ${fmt(this.c.armyStrength(a) / 100)}.</div>`;
    const actions = mine
      ? `<div class="acts">
          <button id="cSplit" ${this.selUnits.size && this.selUnits.size < a.units.length ? '' : 'disabled'} title="Selected units form a new army">Split off</button>
          <button id="cDisband" ${this.selUnits.size ? '' : 'disabled'}>Disband</button>
          <span class="tip">Click units to pick them, right click the map to move just those. ${a.inside && this.c.settlement(a.inside)!.coastal ? 'Right click a coastal town across the sea to sail there.' : ''}</span>
        </div>`
      : `<div class="acts">${this.diploButtons(a.owner)}</div>`;
    return `<div class="ph"><i class="sw" style="background:${f.color}"></i><b>${a.name}</b> <span class="dim">${f.name}${where}</span>
      ${mine ? `<span class="mpb" title="Movement left"><i style="width:${mp}%"></i></span>` : ''}</div>
      <div class="units">${units}</div>${actions}`;
  }

  private diploButtons(fid: string): string {
    if (fid === 'rebels' || fid === this.c.player) return '';
    return this.c.atWar(this.c.player, fid)
      ? `<span class="war">At war</span> <button data-peace="${fid}">Offer peace</button>`
      : `<span class="peace">At peace</span> <button data-war="${fid}">Declare war</button>`;
  }

  private settlementPanel(s: Settlement): string {
    const f = this.c.faction(s.owner);
    const mine = s.owner === this.c.player;
    const rep = this.c.report(s);
    const lvl = settlementLevel(s.pop);
    const head = `<div class="ph"><i class="sw" style="background:${f.color}"></i><b>${s.capital ? '★ ' : ''}${s.name}</b>
      <span class="dim">${s.prov} · ${LEVEL_NAMES[lvl]} · ${f.name}${s.native !== f.culture && f.id !== 'rebels' ? ` · ${s.native} people` : ''}</span></div>`;
    const gar = this.c.garrison(s);
    const garMen = gar.reduce((t, a) => t + this.c.armyMen(a), 0);
    if (!mine) {
      return `${head}<div class="stats"><span>Population <b>${fmt(s.pop)}</b></span><span>Garrison <b>${gar.reduce((t, a) => t + a.units.length, 0)} units</b> (${fmt(garMen)} men)</span>
        <span>Walls <b>${s.buildings.walls ? ['', 'Palisade', 'Stone', 'Great'][s.buildings.walls] : 'None'}</b></span></div><div class="acts">${this.diploButtons(s.owner)}</div>`;
    }
    const order = Math.round(rep.order);
    const stats = `<div class="stats">
      <span>Population <b>${fmt(s.pop)}</b> <em class="${rep.growth >= 0 ? 'pos' : 'neg'}">${rep.growth >= 0 ? '+' : ''}${(rep.growth * 100).toFixed(1)}%</em></span>
      <span title="${rep.orderParts.map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`).join('\n')}">Order <b class="${order >= 80 ? 'pos' : order >= 50 ? '' : 'neg'}">${order}%</b>${order < 70 ? ' riots!' : ''}</span>
      <span title="Taxes ${rep.tax}, trade ${rep.trade}, farms ${rep.farms}, corruption ${Math.round(rep.corruption * 100)}%">Income <b>+${fmt(rep.income)}</b></span>
      <span class="tax">Tax ${TAX_NAMES.map((n, i) => `<button data-tax="${i}" class="${s.tax === i ? 'on' : ''}">${n}</button>`).join('')}</span>
    </div>`;
    const tabs = `<div class="tabs"><button data-tab="recruit" class="${this.tab === 'recruit' ? 'on' : ''}">Recruit</button><button data-tab="build" class="${this.tab === 'build' ? 'on' : ''}">Buildings</button>
      <span class="garr">Garrison: ${gar.length ? gar.map((a) => `<button data-army="${a.id}">${a.name} (${a.units.length})</button>`).join(' ') : 'none'}</span></div>`;
    let body = '';
    if (this.tab === 'recruit') {
      const opts = this.c.recruitable(s);
      const q = s.queue.map((x, i) => `<div class="qi" data-q="${i}" title="Click to cancel">${UNITS[x.unit]?.name ?? x.unit}</div>`).join('');
      body = `<div class="rec">${opts.map((o) => {
        const d = UNITS[o.def.unit];
        const afford = this.c.faction(s.owner).treasury >= o.cost;
        return `<button class="ru ${o.local ? 'local' : ''}" data-rec="${o.def.unit}" ${afford && s.queue.length < 6 ? '' : 'disabled'} title="${d.name}: ${d.men} men, attack ${d.attack}, defense ${d.defense}, armor ${d.armor}, morale ${d.morale}. Upkeep ${upkeep(o.def.unit)}/turn.${o.local ? ' Local troops.' : ''}">
          <span class="n">${d.name}</span><span class="c">${fmt(o.cost)}</span><span class="k">${d.cls}</span></button>`;
      }).join('') || '<div class="hint">Nothing to recruit here. Build a Muster Field or Stables.</div>'}</div>
      <div class="queue">${q ? `Training (${this.c.recruitSlots(s)} per turn): ${q}` : `Up to ${this.c.recruitSlots(s)} unit${this.c.recruitSlots(s) > 1 ? 's' : ''} per turn.`}</div>`;
    } else {
      const cur = s.build ? `<div class="queue">Building <b>${CHAINS.find((c) => c.id === s.build!.chain)!.names[s.build.level - 1]}</b>, ${s.build.turns} turn${s.build.turns > 1 ? 's' : ''} left <button id="cCancelBuild">Cancel</button></div>` : '';
      body = `<div class="blds">${CHAINS.map((c) => {
        const have = s.buildings[c.id] ?? 0;
        const nb = this.c.canBuild(s, c.id);
        if (!nb && !have) return '';
        const name = have ? c.names[have - 1] : '—';
        const btn = nb ? `<button data-build="${c.id}" ${nb.ok ? '' : 'disabled'} title="${nb.why || c.help}">${c.names[nb.level - 1]} · ${fmt(nb.cost)} · ${nb.turns}t</button>` : '<span class="dim">max</span>';
        return `<div class="b"><span class="i">${c.icon}</span><span class="nm" title="${c.help}">${name}</span>${btn}</div>`;
      }).join('')}</div>${cur}`;
    }
    return head + stats + tabs + body;
  }

  private bindPanel(a: Army | null, s: Settlement | null) {
    const p = $('cPanel');
    p.querySelectorAll<HTMLElement>('[data-u]').forEach((el) => {
      el.onclick = () => {
        const i = Number(el.dataset.u);
        if (this.selUnits.has(i)) this.selUnits.delete(i);
        else this.selUnits.add(i);
        this.renderPanel();
      };
    });
    const split = p.querySelector<HTMLButtonElement>('#cSplit');
    if (split && a) split.onclick = () => {
      const b = this.c.split(a, [...this.selUnits]);
      this.selUnits.clear();
      if (b) {
        if (!b.inside) {
          b.x += 3;
          b.y += 2;
        }
        this.selArmy = b.id;
      }
      this.refresh();
    };
    const dis = p.querySelector<HTMLButtonElement>('#cDisband');
    if (dis && a) dis.onclick = async () => {
      if ((await this.ask('Disband units?', `${this.selUnits.size} unit(s) will go home for good.`, ['Disband', 'Cancel'])) !== 0) return;
      [...this.selUnits].sort((x, y) => y - x).forEach((i) => this.c.disband(a, i));
      this.selUnits.clear();
      if (!this.c.army(a.id)) this.selArmy = null;
      this.refresh();
    };
    p.querySelectorAll<HTMLElement>('[data-tax]').forEach((el) => {
      el.onclick = () => {
        if (s) s.tax = Number(el.dataset.tax) as Tax;
        this.refresh();
      };
    });
    p.querySelectorAll<HTMLElement>('[data-tab]').forEach((el) => {
      el.onclick = () => {
        this.tab = el.dataset.tab as 'build' | 'recruit';
        this.renderPanel();
      };
    });
    p.querySelectorAll<HTMLElement>('[data-army]').forEach((el) => {
      el.onclick = () => this.selectArmy(Number(el.dataset.army));
    });
    p.querySelectorAll<HTMLElement>('[data-rec]').forEach((el) => {
      el.onclick = () => {
        if (s && this.c.recruit(s, el.dataset.rec!)) this.refresh();
      };
    });
    p.querySelectorAll<HTMLElement>('[data-q]').forEach((el) => {
      el.onclick = () => {
        if (s) this.c.cancelRecruit(s, Number(el.dataset.q));
        this.refresh();
      };
    });
    p.querySelectorAll<HTMLElement>('[data-build]').forEach((el) => {
      el.onclick = () => {
        if (s && this.c.startBuild(s, el.dataset.build as Chain)) this.refresh();
      };
    });
    const cb = p.querySelector<HTMLButtonElement>('#cCancelBuild');
    if (cb && s) cb.onclick = () => {
      this.c.cancelBuild(s);
      this.refresh();
    };
    p.querySelectorAll<HTMLElement>('[data-war]').forEach((el) => {
      el.onclick = async () => {
        if (await this.confirmWar(el.dataset.war!)) {
          this.c.setWar(this.c.player, el.dataset.war!, true);
          this.c.addLog(`${this.c.faction(this.c.player).name} declare war on ${this.c.faction(el.dataset.war!).name}!`, 'bad');
          this.refresh();
        }
      };
    });
    p.querySelectorAll<HTMLElement>('[data-peace]').forEach((el) => {
      el.onclick = () => this.offerPeace(el.dataset.peace!);
    });
  }

  private async offerPeace(fid: string) {
    const f = this.c.faction(fid);
    if (acceptsPeace(this.c, f)) {
      this.c.setWar(this.c.player, fid, false);
      this.c.addLog(`${this.c.faction(this.c.player).name} and ${f.name} make peace.`, 'good');
      await this.message('Peace', `${f.name} accept your offer of peace.`);
    } else await this.message('Refused', `${f.name} laugh at your envoys. They want to see you beaten first.`);
    this.refresh();
  }

  // ------------------------------------------------------------------ dialogs
  ask(title: string, html: string, buttons: string[]): Promise<number> {
    return new Promise((res) => {
      const d = $('cDialog');
      d.querySelector('.dialog')!.innerHTML = `<h2>${title}</h2><div class="body">${html}</div><div class="choices">${buttons.map((b, i) => `<button data-i="${i}" class="${i === 0 ? 'primary' : ''}">${b}</button>`).join('')}</div>`;
      d.hidden = false;
      d.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) => {
        b.onclick = () => {
          d.hidden = true;
          res(Number(b.dataset.i));
        };
      });
    });
  }

  async message(title: string, html: string): Promise<void> {
    await this.ask(title, html, ['Continue']);
  }

  private sideSummary(side: { faction: string; armies: number[] }): string {
    const f = this.c.faction(side.faction);
    const list = this.c.unitsOf(side);
    const men = list.reduce((t, x) => t + x.u.men, 0);
    const str = list.reduce((t, x) => t + unitStrength(x.u.unit, x.u.men), 0);
    const counts = new Map<string, number>();
    for (const x of list) counts.set(x.u.unit, (counts.get(x.u.unit) ?? 0) + 1);
    return `<div class="bside"><div class="fh"><i style="background:${f.color}"></i>${f.name}</div>
      <div>${list.length} units, ${fmt(men)} men</div><div class="dim">Strength ${fmt(str / 100)}</div>
      <ul>${[...counts].map(([u, n]) => `<li>${n}× ${UNITS[u]?.name ?? u}</li>`).join('')}</ul></div>`;
  }

  private async battlePrompt(b: PendingBattle): Promise<BattleOutcome> {
    const s = b.settlement ? this.c.settlement(b.settlement) : null;
    const playerAttacks = b.attacker.faction === this.c.player;
    const title = s ? (playerAttacks ? `Assault on ${s.name}` : `${s.name} is attacked!`) : playerAttacks ? 'Battle' : 'Your army is attacked!';
    // Move the camera there so the player sees where it happens.
    this.cam.jump(b.x - this.c.map.W / 2, b.y - this.c.map.H / 2, this.cam.yaw, Math.min(this.cam.dist, 140), this.cam.pitch);
    const walls = s?.buildings.walls ? ' The defenders have walls: auto-resolve favours them, a real battle is fought in the open.' : '';
    const pick = await this.ask(title, `<div class="bsides">${this.sideSummary(b.attacker)}<div class="vs">vs</div>${this.sideSummary(b.defender)}</div><p class="dim">${walls}</p>`, ['Fight the battle', 'Auto-resolve']);
    if (pick === 1) {
      const o = this.c.autoResolve(b);
      const won = o.attackerWon === playerAttacks;
      await this.message(won ? 'Victory' : 'Defeat', won ? 'Your men carry the day.' : 'Your army is beaten.');
      return o;
    }
    return this.fight(b);
  }

  private fight(b: PendingBattle): Promise<BattleOutcome> {
    const playerAttacks = b.attacker.faction === this.c.player;
    const mine = playerAttacks ? b.attacker : b.defender;
    const theirs = playerAttacks ? b.defender : b.attacker;
    const toSpec = (side: { faction: string; armies: number[] }) => {
      const f = this.c.faction(side.faction);
      const col = parseInt(f.color.slice(1), 16);
      const trim = parseInt(f.trim.slice(1), 16);
      const fd: FactionDef = { id: f.id, name: f.name, culture: f.culture, primary: col, secondary: col, trim };
      return { faction: fd, units: this.c.unitsOf(side).map((x) => ({ unit: x.u.unit, men: x.u.men })) };
    };
    const s = b.settlement ? this.c.settlement(b.settlement) : null;
    return new Promise((resolve) => {
      $('campaign').hidden = true;
      this.active = false;
      void this.game.start({
        seed: Math.floor(b.x * 131 + b.y * 17) % 9999 + 1,
        playerFaction: 'rome',
        size: this.size,
        campaign: {
          armies: [toSpec(mine), toSpec(theirs)],
          land: b.land,
          title: s ? `Battle for ${s.name}` : `${this.c.faction(mine.faction).name} vs ${this.c.faction(theirs.faction).name}`,
          aiHold: playerAttacks ? 600 : 5,
          onEnd: (battle: Battle, withdrew: boolean) => {
            const surv = (side: number, from: { faction: string; armies: number[] }) => {
              const list = this.c.unitsOf(from);
              const out = list.map((x) => x.u.men);
              for (const u of battle.units) {
                if (u.side !== side || u.src < 0 || u.src >= out.length) continue;
                out[u.src] = Math.round(list[u.src].u.men * Math.min(1, battle.survivors(u) / Math.max(1, u.startMen)));
              }
              return out;
            };
            const playerWon = !withdrew && battle.result?.winner === 0;
            const sv0 = surv(0, mine);
            const sv1 = surv(1, theirs);
            const o: BattleOutcome = {
              attackerWon: playerAttacks ? playerWon : !playerWon,
              survivors: playerAttacks ? [sv0, sv1] : [sv1, sv0],
            };
            this.game.suspend(true);
            $('campaign').hidden = false;
            this.active = true;
            this.resize();
            resolve(o);
          },
        },
      });
      this.game.suspend(false);
    });
  }

  // ------------------------------------------------------------------ turns
  async endTurn() {
    if (this.busy) return;
    this.busy = true;
    this.view.showPath(null);
    $('cEnd').textContent = 'Other nations move…';
    $('cEnd').setAttribute('disabled', '');
    try {
      await new Promise((r) => setTimeout(r, 30));
      await this.c.endTurn(async (c, f) => {
        await aiTurn(c, f);
        this.view.updateOwners();
      });
      this.view.updateOwners();
      this.save();
      const f = this.c.faction(this.c.player);
      if (!f.alive) await this.message('Defeat', `${f.name} is no more. Your campaign is over.`);
    } finally {
      this.busy = false;
      $('cEnd').textContent = 'End turn ⏎';
      this.refresh();
    }
  }

  save() {
    try {
      localStorage.setItem(SAVE_KEY, this.c.save());
    } catch {
      /* storage unavailable: the campaign still runs */
    }
  }

  // ------------------------------------------------------------------ static HUD bindings
  bindHud() {
    $('cEnd').onclick = () => void this.endTurn();
    $('cPolitical').onclick = () => {
      this.view.political = !this.view.political;
      $('cPolitical').classList.toggle('on', this.view.political);
    };
    $('cNations').onclick = () => void this.nations();
    $('cMenu').onclick = async () => {
      const i = await this.ask('Campaign', 'Your campaign saves itself at the end of every turn.', ['Back to the map', 'Save now', 'Exit to main menu']);
      if (i === 1) {
        this.save();
        await this.message('Saved', 'The campaign is saved in this browser.');
      } else if (i === 2) {
        this.save();
        this.close();
      }
    };
  }

  private async nations() {
    const rows = [...this.c.factions.values()].filter((f) => f.alive && f.id !== this.c.player && f.id !== 'rebels').map((f) => {
      const n = this.c.settlements.filter((s) => s.owner === f.id).length;
      const str = this.c.armies.filter((a) => a.owner === f.id).reduce((t, a) => t + this.c.armyStrength(a), 0);
      return `<tr><td><i class="sw" style="background:${f.color}"></i>${f.name}</td><td>${n}</td><td>${fmt(str / 100)}</td><td>${this.diploButtons(f.id)}</td></tr>`;
    }).join('');
    const d = $('cDialog');
    d.querySelector('.dialog')!.innerHTML = `<h2>Nations</h2><table class="nations"><tr><th></th><th>Towns</th><th>Army</th><th></th></tr>${rows}</table><div class="choices"><button data-close class="primary">Close</button></div>`;
    d.hidden = false;
    d.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => (d.hidden = true);
    d.querySelectorAll<HTMLElement>('[data-war]').forEach((el) => {
      el.onclick = async () => {
        d.hidden = true;
        if (await this.confirmWar(el.dataset.war!)) {
          this.c.setWar(this.c.player, el.dataset.war!, true);
          this.c.addLog(`${this.c.faction(this.c.player).name} declare war on ${this.c.faction(el.dataset.war!).name}!`, 'bad');
        }
        this.refresh();
      };
    });
    d.querySelectorAll<HTMLElement>('[data-peace]').forEach((el) => {
      el.onclick = async () => {
        d.hidden = true;
        await this.offerPeace(el.dataset.peace!);
      };
    });
  }
}

/** A short opening text for each faction. */
function intro(fid: string): string {
  const t: Record<string, string> = {
    rome: 'Pyrrhus has left Italy and Tarentum has fallen. Rome rules the peninsula south of the Arno, but the Gauls of the Po valley are restless, and across the strait Carthage and Syracuse fight over Sicily.',
    carthage: 'Carthage rules the sea from Gades to Sicily. Syracuse resists in the east of the island, and the Romans, new masters of Italy, are watching the strait of Messana.',
    gauls: 'The tribes of Gaul are strong and many, but divided. Rome presses on the Cisalpine lands, and the Germans raid across the Rhine.',
    britons: 'The island tribes are safe behind the sea. Gaul lies across the channel.',
    germans: 'The forest tribes are poor in towns but rich in warriors. Gaul is wealthy and close.',
    iberians: 'Celtiberians and Iberians hold the peninsula, while Carthage trades on its southern coast.',
    greeks: 'Athens, Sparta, Rhodes and Byzantion still stand free. Macedon wants Greece; the Chremonidean War is coming.',
    macedon: 'Antigonus Gonatas holds Macedon and the fortresses of Greece. The free cities and Epirus stand against him.',
    seleucids: 'Antiochus rules from the Aegean to Babylon, and is at war with Ptolemy over Syria.',
    ptolemies: 'Egypt is the richest kingdom on earth. Its fleets hold the coasts of Syria, Cyprus and Asia.',
    thrace: 'The Odrysian kings rule inland Thrace between Macedon and the Celtic kingdom of Tylis.',
    dacia: 'The Getae and Dacians hold the Carpathians and the Danube plain.',
    scythia: 'The horse lords rule the steppe above the Black Sea.',
    pontus: 'Mithridates founded this young kingdom on the Black Sea coast.',
    armenia: 'The Orontid kings rule the high mountain country.',
    numidia: 'The Numidian horsemen are Carthage’s allies, for now.',
  };
  return `${t[fid] ?? 'The world lies open before you.'}<p class="dim">Select towns to build and recruit, select armies and right click to march. Battles can be fought for real or auto-resolved.</p>`;
}

export function playableFactions() {
  return WORLD.factions.filter((f) => f.playable);
}

export { MAX_UNITS, HS };
