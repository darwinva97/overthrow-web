// HUD en DOM, el mismo para 2D y 3D. Se construye una vez y en cada frame solo
// se actualizan los valores que cambian.
import { ABILITIES, HEROES, ITEMS, abilityIcon, heroIcon, heroPortrait, itemIcon, lv, type ItemData } from '../../../shared/data';
import type { BoardRow, SAbility, SItem, SMe } from '../../../shared/net/protocol';
import { isShopItem, shopItems } from '../../../shared/sim/items';
import type { Fx } from '../../../shared/sim/types';
import { Fog, terrainCanvas } from '../render/terrain';
import type { Camera, View } from '../render/types';
import { ORB_COLOR } from '../render/fxstyle';

const STAT_ES: Record<string, string> = {
  bonus_strength: 'fuerza', bonus_agility: 'agilidad', bonus_intellect: 'inteligencia', bonus_all_stats: 'a todos los atributos',
  bonus_damage: 'daño', bonus_attack_speed: 'velocidad de ataque', bonus_armor: 'armadura', bonus_health: 'vida', bonus_mana: 'maná',
  bonus_health_regen: 'regeneración de vida', bonus_mana_regen: 'regeneración de maná', bonus_movement_speed: 'velocidad de movimiento',
  bonus_evasion: '% evasión', bonus_magical_armor: '% resistencia mágica', bonus_spell_resist: '% resistencia mágica', bonus_speed: 'velocidad de ataque',
  bonus_chance: '% probabilidad', bonus_chance_damage: 'daño mágico al activarse', bonus_movement: 'velocidad de movimiento', bonus_cooldown: '% reducción de enfriamiento',
};

export const IT_KEYS = ['1', '2', '3', '4', '5', '6'];

/** Teclas como en Dota: la definitiva en R y el resto en Q W E D F por orden de hueco. */
export function abilityKeyMap(ab: SAbility[]): Map<number, string> {
  const out = new Map<number, string>();
  const keys = ['Q', 'W', 'E', 'D', 'F'];
  let k = 0, ultUsed = false;
  ab.forEach((a, i) => {
    // Las innatas pasivas no llevan tecla; las activas (Invoke) sí.
    if (a.hidden || !a.av || (a.innate && a.tk === 'passive')) return;
    if (a.ult && !ultUsed) { out.set(i, 'R'); ultUsed = true; return; }
    const key = keys[k++];
    if (key) out.set(i, key);
  });
  return out;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const iconFor = (k: string) => (k.startsWith('/') || k.startsWith('http') ? k : itemIcon(k));

export interface HudActions {
  castAbility(slot: number, self: boolean): void;
  useItem(slot: number, self: boolean): void;
  learn(slot: number): void;
  buy(key: string): void;
  sell(slot: number): void;
  swap(a: number, b: number): void;
  pickOrb(i: number): void;
  pickTalent(key: string): void;
  pickNeutral(trinket: number, enhancement: number): void;
  toggleMode(): void;
  toggleControlAll(): void;
  minimapClick(x: number, y: number, button: number): void;
  chat(text: string): void;
  leave(): void;
}

/** Coste real de un item descontando componentes que ya se tienen. */
export function costWithOwned(key: string, owned: string[]): number {
  const pool = [...owned];
  const plan = (k: string): number => {
    const i = pool.indexOf(k);
    if (i >= 0) { pool.splice(i, 1); return 0; }
    const d = ITEMS[k];
    if (!d) return Infinity;
    if (!d.components.length) return d.cost;
    return d.recipeCost + d.components.reduce((s, c) => s + plan(c), 0);
  };
  const d = ITEMS[key];
  if (!d) return Infinity;
  if (!d.components.length) return d.cost;
  return d.recipeCost + d.components.reduce((s, c) => s + plan(c), 0);
}

export class Hud {
  el = h('div', 'hud');
  private race = h('div', 'race');
  private raceTrack = h('div', 'track');
  private raceMeta = h('div', 'meta');
  private gems = new Map<number, HTMLElement>();
  private modeBtn = h('button', 'chip');
  private allBtn = h('button', 'chip');
  private pingChip = h('div', 'chip');
  private feed = h('div', 'feed');
  private announceEl = h('div', 'announce');
  private dock = h('div', 'dock');
  private portraitImg = h('img') as HTMLImageElement;
  private lvlEl = h('div', 'lvl');
  private deadEl = h('div', 'dead');
  private statsEl = h('div', 'stats');
  private abilitiesEl = h('div', 'abilities');
  private abEls: HTMLButtonElement[] = [];
  private hpBar = h('div', 'meter hp');
  private mpBar = h('div', 'meter mp');
  private xpBar = h('div', 'meter xp');
  private itemsEl = h('div', 'items');
  private itEls: HTMLButtonElement[] = [];
  private goldEl = h('div', 'gold');
  private stashEl = h('div', 'stash');
  private buffsEl = h('div', 'buffs');
  private minimap = h('div', 'minimap');
  private mm = h('canvas') as HTMLCanvasElement;
  private mmTerrain: HTMLCanvasElement;
  private mmFog: Fog;
  private shop = h('div', 'shop');
  private shopGrid = h('div', 'grid');
  private shopTab = 'basic';
  private shopSearch = h('input', 'input') as HTMLInputElement;
  private orbsEl = h('div', 'orbs');
  private neutralEl = h('div', 'orbs neutral');
  private talentBtn = h('button', 'talent-btn', 'Talentos');
  private talentEl = h('div', 'talents');
  private aghsEl = h('div', 'aghs');
  private lastTalent = '';
  private lastNeutral = '';
  private neutralChoice: [number, number] = [-1, -1];
  private toastEl = h('div', 'toast');
  private boardEl = h('div', 'board');
  private chatEl = h('div', 'chat');
  private chatInput = h('input') as HTMLInputElement;
  private tip = h('div', 'tip');
  private lastAb = '';
  private lastIt = '';
  private lastOrb = '';
  private lastShop = '';
  private toastTimer = 0;
  private announceTimer = 0;
  private me: SMe | null = null;
  private dragFrom = -1;
  private v: View | null = null;

  private act: HudActions;
  private ctx: { killGoal: number; timeLimit: number; teams: { id: number; name: string; color: string }[]; team: number; layout: import('../../../shared/maps').MapLayout; terrain: HTMLCanvasElement };

  constructor(act: HudActions, ctx: { killGoal: number; timeLimit: number; teams: { id: number; name: string; color: string }[]; team: number; layout: import('../../../shared/maps').MapLayout; terrain: HTMLCanvasElement }) {
    this.act = act; this.ctx = ctx;
    const el = this.el;
    // Carrera hacia el kill goal.
    this.raceTrack.append(h('div', 'goal', String(ctx.killGoal)));
    for (const t of ctx.teams) {
      const g = h('div', 'gem' + (t.id === ctx.team ? ' mine' : ''), '<span>0</span>');
      g.style.background = t.color;
      g.title = t.name;
      this.gems.set(t.id, g);
      this.raceTrack.append(g);
    }
    this.race.append(this.raceTrack, this.raceMeta);
    const tr = h('div', 'topright');
    this.modeBtn.onclick = () => act.toggleMode();
    this.allBtn.onclick = () => act.toggleControlAll();
    const leave = h('button', 'chip', 'Salir');
    leave.onclick = () => { if (confirm('¿Salir de la partida? Un bot seguirá con tu héroe.')) act.leave(); };
    tr.append(this.pingChip, this.allBtn, this.modeBtn, leave);

    // Dock inferior.
    const bar = h('div', 'bar');
    const portrait = h('div', 'portrait');
    const pic = h('div', 'pic');
    pic.append(this.portraitImg, this.lvlEl, this.deadEl);
    this.talentBtn.onclick = () => this.talentEl.classList.toggle('open');
    this.talentBtn.title = 'Árbol de talentos (nivel 10, 15, 20 y 25)';
    const prow = h('div', 'prow');
    prow.append(this.talentBtn, this.aghsEl);
    portrait.append(prow, pic, this.xpBar);
    this.xpBar.innerHTML = '<div class="fill"></div>';
    const center = h('div', 'center');
    for (const m of [this.hpBar, this.mpBar]) m.innerHTML = '<div class="fill"></div><div class="txt"></div><div class="reg"></div>';
    const bars = h('div', 'bars');
    bars.append(this.hpBar, this.mpBar);
    center.append(this.abilitiesEl, bars);
    for (let i = 0; i < 10; i++) {
      const b = h('button', 'it' + (i >= 6 && i < 9 ? ' back' : i === 9 ? ' neutral' : '')) as HTMLButtonElement;
      b.dataset.slot = String(i);
      b.draggable = true;
      b.onclick = (e) => act.useItem(i, e.altKey);
      b.oncontextmenu = (e) => { e.preventDefault(); if (this.me?.shop && this.me.it[i]) act.sell(i); };
      b.ondragstart = () => { this.dragFrom = i; };
      b.ondragover = (e) => e.preventDefault();
      b.ondrop = (e) => { e.preventDefault(); if (this.dragFrom >= 0) act.swap(this.dragFrom, i); this.dragFrom = -1; };
      b.onmouseenter = () => this.showItemTip(b, this.me?.it[i]?.k, i);
      b.onmouseleave = () => this.hideTip();
      this.itEls.push(b);
      this.itemsEl.append(b);
    }
    const side = h('div', 'side');
    const shopBtn = h('button', '', 'Tienda <kbd>B</kbd>');
    shopBtn.onclick = () => this.toggleShop();
    this.goldEl.append(h('span'), shopBtn);
    side.append(this.goldEl, h('div', 'stash-l', 'Alijo: llega al volver a la base'), this.stashEl);
    this.dock.append(portrait, this.statsEl, center, this.itemsEl, side);
    this.dock.append(this.buffsEl);
    bar.append(this.dock);

    // Minimapa.
    this.minimap.append(this.mm);
    this.mmTerrain = ctx.terrain;
    this.mmFog = new Fog(ctx.layout);
    const mmPos = (e: MouseEvent) => {
      const r = this.mm.getBoundingClientRect();
      const L = ctx.layout;
      const size = L.grid.w * 64;
      return { x: L.grid.ox + ((e.clientX - r.left) / r.width) * size, y: L.grid.oy + ((e.clientY - r.top) / r.height) * size };
    };
    let mmDown = false;
    this.mm.onmousedown = (e) => { e.preventDefault(); mmDown = e.button === 0; const p = mmPos(e); act.minimapClick(p.x, p.y, e.button); };
    this.mm.onmousemove = (e) => { if (mmDown) { const p = mmPos(e); act.minimapClick(p.x, p.y, 0); } };
    window.addEventListener('mouseup', () => { mmDown = false; });
    this.mm.oncontextmenu = (e) => e.preventDefault();

    // Tienda.
    const sh = h('header');
    sh.append(h('h3', '', 'Tienda'), this.shopSearch);
    this.shopSearch.placeholder = 'Buscar item';
    this.shopSearch.oninput = () => { this.shopTab = 'search'; this.lastShop = ''; this.renderTabs(tabs); };
    this.shopSearch.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') this.toggleShop(false); };
    const tabs = h('div', 'tabs');
    this.renderTabs(tabs);
    this.shop.append(sh, tabs, this.shopGrid, h('div', 'note', 'Clic para comprar. Si no estás en tu base, va al alijo. Clic derecho en un item de tu inventario para venderlo estando en la base.'));

    this.chatInput.className = 'input';
    this.chatInput.maxLength = 200;
    this.chatInput.placeholder = 'Escribe y pulsa Intro';
    this.chatInput.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = this.chatInput.value.trim(); if (t) act.chat(t); this.closeChat(); }
      if (e.key === 'Escape') this.closeChat();
    };
    this.chatEl.append(this.chatInput);
    const help = h('div', 'help', 'Clic derecho: mover o atacar<br>Q W E R: habilidades (Ctrl para aprender)<br>1–6: items · A: atacar · S: parar<br>Espacio: centrar · Y: fijar cámara<br>Tab: marcador · B: tienda · F2: 2D/3D');
    setTimeout(() => help.remove(), 45000);
    this.dock.append(this.talentEl);
    el.append(this.race, tr, this.feed, this.announceEl, this.minimap, bar, this.shop, this.orbsEl, this.neutralEl, this.toastEl, this.boardEl, this.chatEl, help);
    document.body.append(this.tip);
  }

  private renderTabs(tabs: HTMLElement) {
    tabs.innerHTML = '';
    for (const [k, label] of [['consumable', 'Consumibles'], ['basic', 'Básicos'], ['upgrade', 'Mejoras'], ['search', 'Resultados']] as const) {
      if (k === 'search' && !this.shopSearch.value) continue;
      const b = h('button', '', label);
      b.setAttribute('aria-pressed', String(this.shopTab === k));
      b.onclick = () => { this.shopTab = k; this.lastShop = ''; this.renderTabs(tabs); };
      tabs.append(b);
    }
  }

  toggleShop(open?: boolean) {
    const o = open ?? !this.shop.classList.contains('open');
    this.shop.classList.toggle('open', o);
    this.lastShop = '';
    if (o) setTimeout(() => this.shopSearch.focus({ preventScroll: true }), 0);
    else this.shopSearch.blur();
  }
  get shopOpen() { return this.shop.classList.contains('open'); }

  openChat() { this.chatEl.classList.add('typing'); this.chatInput.value = ''; this.chatInput.focus(); }
  closeChat() { this.chatEl.classList.remove('typing'); this.chatInput.blur(); }
  get typing() { return document.activeElement === this.chatInput || document.activeElement === this.shopSearch; }

  showBoard(on: boolean) { this.boardEl.classList.toggle('open', on); }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1600);
  }

  announce(msg: string) {
    this.announceEl.textContent = msg;
    this.announceEl.classList.add('show');
    clearTimeout(this.announceTimer);
    this.announceTimer = window.setTimeout(() => this.announceEl.classList.remove('show'), 2600);
  }

  chatLine(from: string, text: string, color: string) {
    const d = h('div', 'line');
    d.innerHTML = `<b style="color:${color}">${esc(from)}:</b> ${esc(text)}`;
    this.chatEl.insertBefore(d, this.chatInput);
    setTimeout(() => d.remove(), 12000);
    while (this.chatEl.children.length > 8) this.chatEl.firstChild!.remove();
  }

  onFx(f: Fx, v: View) {
    if (f.n === 'kill') {
      const victim = v.byId.get(f.u!), killer = v.byId.get(f.u2!);
      const row = h('div');
      const kn = killer?.n;
      row.innerHTML = `${kn ? `<img src="${heroIcon(kn)}" alt="">` : ''}<span style="color:${this.ctx.teams[f.t!]?.color}">mata a</span>${victim ? `<img src="${heroIcon(victim.n)}" alt="">` : ''}`;
      this.feed.prepend(row);
      setTimeout(() => row.remove(), 7000);
      while (this.feed.children.length > 6) this.feed.lastChild!.remove();
      if (f.u === v.hero?.i) this.announce('Has caído');
    } else if (f.n === 'announce') {
      if (f.c === 'orb') this.announce('El Kobold King lanza un orbe');
      if (f.c === 'epic_orb') this.announce('Llega una entrega de orbe épico');
      if (f.c === 'overtime') this.announce('Prórroga: la siguiente kill gana');
    } else if (f.n === 'orb_capture') {
      const t = this.ctx.teams[f.t!];
      this.announce(f.t === this.ctx.team ? 'Tu equipo captura el orbe' : `${t?.name ?? 'Otro equipo'} captura el orbe`);
    }
  }

  update(v: View, cam: Camera, cornersWorld: { x: number; y: number }[], extra: { mode: string; controlAll: boolean; ping: number; targetingSlot: string }) {
    this.v = v;
    const me = v.me;
    this.me = me;
    this.modeBtn.innerHTML = `${extra.mode === '3d' ? '3D' : '2D'} <kbd>F2</kbd>`;
    this.modeBtn.title = 'Cambiar entre vista 2D y 3D';
    this.allBtn.innerHTML = `${extra.controlAll ? 'Todas mis unidades' : 'Solo el héroe'} <kbd>F3</kbd>`;
    this.allBtn.setAttribute('aria-pressed', String(extra.controlAll));
    this.pingChip.textContent = `${Math.round(extra.ping)} ms`;
    this.updateRace(v);
    this.drawMinimap(v, cornersWorld);
    if (!me) return;
    const portrait = heroPortrait(v.hero?.n ?? '');
    if (v.hero && this.portraitImg.src !== location.origin + portrait) this.portraitImg.src = portrait;
    const xpK = me.xpNext ? (me.xp - me.xpPrev) / (me.xpNext - me.xpPrev) : 1;
    this.lvlEl.innerHTML = `<svg viewBox="0 0 30 30"><circle cx="15" cy="15" r="13" fill="none" stroke="#e0a84a" stroke-width="3" stroke-dasharray="${(xpK * 81.7).toFixed(1)} 82" transform="rotate(-90 15 15)"/></svg>${me.lvl}`;
    (this.xpBar.firstChild as HTMLElement).style.transform = `scaleX(${xpK})`;
    this.deadEl.style.display = me.dead ? 'grid' : 'none';
    this.deadEl.textContent = String(me.dead);
    const u = v.hero;
    this.setMeter(this.hpBar, u ? u.h : 0, u ? u.H : 1, me.stats.hpr);
    this.setMeter(this.mpBar, u ? u.m : 0, u ? u.M : 1, me.stats.mpr);
    const st = me.stats;
    this.statsEl.innerHTML = `<span>Daño</span><b>${st.dmg}</b><span>Armadura</span><b>${st.armor}</b><span>Vel. ataque</span><b>${st.as}</b><span>Res. mágica</span><b>${st.mr}%</b><span>Velocidad</span><b>${st.ms}</b><span>Alcance</span><b>${st.range}</b>` +
      `<span style="color:#e57d70">Fuerza</span><b>${st.str}</b><span style="color:#7fcf72">Agilidad</span><b>${st.agi}</b><span style="color:#6faee8">Inteligencia</span><b>${st.int}</b><span>K/M/A</span><b>${me.kda[0]}/${me.kda[1]}/${me.kda[2]}</b>`;
    (this.goldEl.firstChild as HTMLElement).textContent = `${me.gold} oro`;
    this.updateAbilities(me, extra.targetingSlot);
    this.updateItems(me, extra.targetingSlot);
    this.updateBuffs(me);
    this.updateOrbs(me);
    this.updateTalents(me);
    this.updateNeutral(me);
    this.updateAghs(me, v.hero?.n ?? '');
    if (this.shopOpen) this.updateShop(me);
    if (this.boardEl.classList.contains('open')) this.updateBoard(v.board);
  }

  private setMeter(el: HTMLElement, cur: number, max: number, reg: number) {
    const [fill, txt, rg] = el.children as unknown as HTMLElement[];
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, cur / max))})`;
    txt.textContent = `${Math.round(cur)} / ${Math.round(max)}`;
    rg.textContent = `+${reg.toFixed(1)}`;
  }

  private updateRace(v: View) {
    const ks = v.killsByTeam;
    const goal = this.ctx.killGoal;
    // Equipos empatados se apilan un poco para que no se tapen.
    const seen = new Map<number, number>();
    for (const t of this.ctx.teams) {
      const k = ks[t.id] ?? 0;
      const g = this.gems.get(t.id)!;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      g.style.left = `calc(${(Math.min(k, goal) / goal) * 94 + 3}% + ${n * 6}px)`;
      g.style.top = `calc(50% + ${n % 2 ? 6 : 0}px)`;
      (g.firstChild as HTMLElement).textContent = String(k);
    }
    const remaining = Math.max(0, this.ctx.timeLimit - v.tm);
    this.raceMeta.innerHTML = `<span class="clock">${fmtTime(v.tm)}</span><span class="phase">${v.night ? 'Noche' : 'Día'} · quedan ${fmtTime(remaining)}</span>`;
  }

  private updateAbilities(me: SMe, targeting: string) {
    const sig = me.ab.map((a) => `${a.k}${a.l}${a.can}${a.av}${a.hidden}`).join() + me.ap;
    if (sig !== this.lastAb) {
      this.lastAb = sig;
      this.abilitiesEl.innerHTML = '';
      this.abEls = [];
      const keys = abilityKeyMap(me.ab);
      // Las innatas van primero y pequeñas; las de Scepter/Shard solo con el objeto.
      const order = me.ab.map((a, i) => [a, i] as const).filter(([a]) => !a.hidden && a.av)
        .sort(([a, i], [b, j]) => Number(b.innate && b.tk === 'passive') - Number(a.innate && a.tk === 'passive') || i - j);
      order.forEach(([a, slot]) => {
        const small = a.innate && a.tk === 'passive';
        const b = h('button', 'ab' + (small ? ' innate' : '')) as HTMLButtonElement;
        const k = keys.get(slot) ?? '';
        b.innerHTML = `<img src="${abilityIcon(a.k)}" alt="" onerror="this.src='${itemIcon('ultimate_orb')}'"><div class="cd"></div>${k ? `<span class="key">${k}</span>` : ''}<span class="mc"></span>` +
          (a.innate || a.max <= 1 ? '' : `<div class="pips">${Array.from({ length: a.max }, (_, i) => `<i class="${i < a.l ? 'on' : ''}"></i>`).join('')}</div>`);
        if (a.can) {
          const lb = h('button', 'learn', '+');
          lb.title = 'Aprender (Ctrl + tecla)';
          lb.onclick = (e) => { e.stopPropagation(); this.act.learn(slot); };
          b.append(lb);
        }
        b.dataset.key = k;
        b.onclick = (e) => this.act.castAbility(slot, e.altKey);
        b.onmouseenter = () => this.showAbilityTip(b, a);
        b.onmouseleave = () => this.hideTip();
        this.abEls[slot] = b;
        this.abilitiesEl.append(b);
      });
    }
    me.ab.forEach((a, slot) => {
      const b = this.abEls[slot];
      if (!b) return;
      const cd = b.querySelector('.cd') as HTMLElement | null;
      if (!cd) return;
      const onCd = a.ch >= 0 ? a.ch === 0 && a.cd > 0 : a.cd > 0;
      cd.textContent = onCd ? (a.cd >= 1 ? String(Math.ceil(a.cd)) : a.cd.toFixed(1)) : '';
      cd.style.background = onCd && a.mcd > 0 ? `conic-gradient(#000a ${(a.cd / Math.max(0.01, a.mcd)) * 360}deg, transparent 0)` : '';
      (b.querySelector('.mc') as HTMLElement | null)!.textContent = a.mc && a.l ? String(a.mc) : '';
      b.classList.toggle('unlearned', a.l === 0);
      b.classList.toggle('nomana', a.l > 0 && a.mc > (this.v?.hero?.m ?? 0));
      b.classList.toggle('toggled', a.tg);
      b.classList.toggle('active', targeting === `a${slot}`);
      let ch = b.querySelector('.charges') as HTMLElement | null;
      if (a.ch >= 0 && a.l > 0) {
        if (!ch) { ch = h('span', 'charges'); b.append(ch); }
        ch.textContent = String(a.ch);
      } else ch?.remove();
    });
  }

  private updateItems(me: SMe, targeting: string) {
    const sig = me.it.map((i) => i?.k ?? '').join() + me.st.join();
    if (sig !== this.lastIt) {
      this.lastIt = sig;
      me.it.forEach((it, i) => {
        const b = this.itEls[i];
        b.innerHTML = it ? `<img src="${itemIcon(it.k)}" alt="">${i < 6 ? `<span class="key">${IT_KEYS[i]}</span>` : i === 9 ? '<span class="key">0</span>' : ''}<div class="cd"></div><span class="ch"></span>` : '';
      });
      this.stashEl.innerHTML = me.st.map((k) => `<img src="${itemIcon(k)}" alt="${esc(ITEMS[k]?.name ?? k)}" title="${esc(ITEMS[k]?.name ?? k)}">`).join('');
    }
    me.it.forEach((it, i) => {
      const b = this.itEls[i];
      if (!it) return;
      const cd = b.querySelector('.cd') as HTMLElement | null;
      if (cd) {
        cd.textContent = it.cd > 0 ? String(Math.ceil(it.cd)) : '';
        cd.style.background = it.cd > 0 && it.mcd ? `conic-gradient(#000a ${(it.cd / it.mcd) * 360}deg, transparent 0)` : '';
      }
      const ch = b.querySelector('.ch') as HTMLElement | null;
      if (ch) ch.textContent = it.ch >= 0 ? String(it.ch) : it.k === 'power_treads' ? ['F', 'A', 'I'][it.md] : '';
      b.classList.toggle('toggled', it.tg);
      b.classList.toggle('active', targeting === `i${i}`);
    });
  }

  private updateBuffs(me: SMe) {
    const html = me.buffs.filter((b) => b.r !== -1 || b.s > 1 || b.fx).slice(0, 12).map((b) => {
      const icon = b.src ? (ABILITIES[b.src] ? abilityIcon(b.src) : itemIcon(b.src)) : itemIcon('ultimate_orb');
      const label = b.s > 1 ? b.s : b.r > 0 ? Math.ceil(b.r) : '';
      return `<div class="buff${b.db ? ' db' : ''}" title="${esc(b.n.replaceAll('_', ' '))}"><img src="${icon}" alt=""><span>${label}</span></div>`;
    }).join('');
    if (this.buffsEl.innerHTML !== html) this.buffsEl.innerHTML = html;
  }

  private updateOrbs(me: SMe) {
    const sig = me.orb ? me.orb.options.map((o) => o.id).join() + me.orbN : '';
    if (sig === this.lastOrb) return;
    this.lastOrb = sig;
    this.orbsEl.classList.toggle('open', !!me.orb);
    if (!me.orb) return;
    const names = { common: 'común', rare: 'raro', epic: 'épico' } as const;
    this.orbsEl.innerHTML = `<h3 style="color:${ORB_COLOR[me.orb.rarity]}">Orbe ${names[me.orb.rarity]}${me.orbN > 1 ? ` (${me.orbN} pendientes)` : ''}</h3>`;
    const opts = h('div', 'opts');
    me.orb.options.forEach((o, i) => {
      const b = h('button', `orb-opt rarity-${me.orb!.rarity}`);
      b.innerHTML = `<img src="${iconFor(o.icon)}" alt=""><b>${esc(o.label)}</b><kbd>Alt + ${i + 1}</kbd>`;
      b.onclick = () => this.act.pickOrb(i);
      opts.append(b);
    });
    this.orbsEl.append(opts);
  }

  private updateTalents(me: SMe) {
    const can = me.talents.some((r) => r.can);
    this.talentBtn.classList.toggle('ready', can);
    const sig = JSON.stringify(me.talents);
    if (sig === this.lastTalent) return;
    this.lastTalent = sig;
    this.talentEl.innerHTML = '<h4>Talentos</h4>';
    for (const row of [...me.talents].reverse()) {
      const r = h('div', 'trow' + (row.can ? ' can' : ''));
      const [a, b] = row.options;
      const opt = (o: typeof a | undefined) => {
        const btn = h('button', 'topt' + (o?.picked ? ' picked' : '')) as HTMLButtonElement;
        btn.textContent = o?.name ?? '';
        btn.disabled = !row.can || !o;
        if (o) btn.onclick = () => this.act.pickTalent(o.key);
        return btn;
      };
      r.append(opt(a), h('span', 'tlvl', String(row.level)), opt(b));
      this.talentEl.append(r);
    }
  }

  private updateAghs(me: SMe, hero: string) {
    const sig = `${me.scepter}${me.shard}${hero}`;
    if (this.aghsEl.dataset.sig === sig) return;
    this.aghsEl.dataset.sig = sig;
    const ag = HEROES[hero]?.aghs;
    this.aghsEl.innerHTML = '';
    for (const [k, on, title, desc] of [
      ['ultimate_scepter', me.scepter, `Aghanim's Scepter${ag?.scepterSkill ? ` · ${ag.scepterSkill}` : ''}`, ag?.scepter ?? ''],
      ['aghanims_shard', me.shard, `Aghanim's Shard${ag?.shardSkill ? ` · ${ag.shardSkill}` : ''}`, ag?.shard ?? ''],
    ] as const) {
      const i = h('img') as HTMLImageElement;
      i.src = itemIcon(k);
      i.className = on ? 'on' : '';
      i.alt = title;
      i.onmouseenter = () => { this.tip.innerHTML = `<h4>${esc(title)}</h4>${on ? '' : '<span class="k">No lo tienes.</span>\n'}${esc(desc || 'Este héroe no tiene mejora.')}`; this.place(i); };
      i.onmouseleave = () => this.hideTip();
      this.aghsEl.append(i);
    }
  }

  private updateNeutral(me: SMe) {
    const p = me.neutral;
    const sig = p ? `${p.tier}${p.trinkets.join()}${p.enhancements.join()}${this.neutralChoice.join()}` : '';
    if (sig === this.lastNeutral) return;
    this.lastNeutral = sig;
    this.neutralEl.classList.toggle('open', !!p);
    if (!p) { this.neutralChoice = [-1, -1]; return; }
    this.neutralEl.innerHTML = `<h3>Objeto neutral · tier ${p.tier}</h3><p class="hint">Elige un objeto y un encantamiento. El objeto va a tu hueco neutral; el encantamiento te da stats.</p>`;
    const row = (keys: string[], which: 0 | 1) => {
      const r = h('div', 'opts');
      keys.forEach((k, i) => {
        const b = h('button', 'orb-opt' + (this.neutralChoice[which] === i ? ' chosen' : ''));
        const d = ITEMS[k];
        b.innerHTML = `<img src="${itemIcon(k)}" alt=""><b>${esc(d?.name ?? k)}</b>`;
        b.onclick = () => { this.neutralChoice[which] = i; this.lastNeutral = ''; };
        b.onmouseenter = () => this.showItemTip(b, k, -1);
        b.onmouseleave = () => this.hideTip();
        r.append(b);
      });
      return r;
    };
    const ok = h('button', 'btn primary', 'Elegir') as HTMLButtonElement;
    ok.disabled = this.neutralChoice[0] < 0 || this.neutralChoice[1] < 0;
    ok.onclick = () => { this.act.pickNeutral(this.neutralChoice[0], this.neutralChoice[1]); this.neutralChoice = [-1, -1]; };
    this.neutralEl.append(row(p.trinkets, 0), row(p.enhancements, 1), ok);
  }

  private updateShop(me: SMe) {
    const owned = [...me.it.filter((i): i is SItem => !!i).map((i) => i.k), ...me.st];
    const q = this.shopSearch.value.trim().toLowerCase();
    const sig = `${this.shopTab}|${q}|${owned.join()}|${Math.floor(me.gold / 25)}`;
    if (sig === this.lastShop) return;
    this.lastShop = sig;
    const all = shopItems().filter((d) => !d.key.startsWith('dagon_'));
    const pick = (d: ItemData) => {
      if (this.shopTab === 'search') return d.name.toLowerCase().includes(q) || d.key.includes(q);
      if (this.shopTab === 'consumable') return d.qual === 'consumable';
      if (this.shopTab === 'basic') return d.qual !== 'consumable' && !d.components.length;
      return d.components.length > 0;
    };
    const list = all.filter(pick).sort((a, b) => a.cost - b.cost);
    this.shopGrid.innerHTML = '';
    for (const d of list) {
      const cost = costWithOwned(d.key, owned);
      const b = h('button', 'si' + (cost > me.gold ? ' cant' : '') + (owned.includes(d.key) ? ' owned' : '')) as HTMLButtonElement;
      b.innerHTML = `<img src="${itemIcon(d.key)}" alt="${esc(d.name)}"><span>${cost}</span>`;
      b.onclick = () => this.act.buy(d.key);
      b.onmouseenter = () => this.showItemTip(b, d.key, -1, cost);
      b.onmouseleave = () => this.hideTip();
      this.shopGrid.append(b);
    }
  }

  private updateBoard(rows: BoardRow[]) {
    const byTeam = [...rows].sort((a, b) => a.team - b.team || b.k - a.k);
    this.boardEl.innerHTML = `<table><tr><th></th><th>Jugador</th><th>Equipo</th><th>Nv</th><th>K</th><th>M</th><th>A</th><th></th></tr>${byTeam.map((r) => `
      <tr class="${r.alive ? '' : 'dead'}"><td><img src="${heroIcon(r.hero)}" alt=""></td><td>${esc(r.name)}${r.bot ? ' <span class="k">(bot)</span>' : ''}</td>
      <td style="color:${this.ctx.teams[r.team]?.color}">${esc(this.ctx.teams[r.team]?.name ?? '')}</td><td>${r.lvl}</td><td>${r.k}</td><td>${r.d}</td><td>${r.a}</td>
      <td>${r.alive ? '' : `reaparece en ${r.respawn}`}</td></tr>`).join('')}</table>`;
  }

  private drawMinimap(v: View, corners: { x: number; y: number }[]) {
    const c = this.mm;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = c.clientWidth || 230;
    if (c.width !== Math.round(W * dpr)) { c.width = c.height = Math.round(W * dpr); }
    const x = c.getContext('2d')!;
    const L = v.layout;
    const size = L.grid.w * 64;
    const s = c.width / size;
    const P = (wx: number, wy: number) => [(wx - L.grid.ox) * s, (wy - L.grid.oy) * s];
    x.drawImage(this.mmTerrain, 0, 0, c.width, c.height);
    const eyes = v.units.filter((u) => u.t === v.team && u.v).map((u) => ({ x: u.px, y: u.py, v: u.v! }));
    this.mmFog.update(eyes, v.night, v.vz);
    x.drawImage(this.mmFog.canvas, 0, 0, c.width, c.height);
    for (const u of v.units) {
      const [px, py] = P(u.px, u.py);
      if (u.k === 'orb') {
        const o = v.orbs.find((q) => q.i === u.i);
        x.fillStyle = ORB_COLOR[o?.r ?? 'common'];
        x.beginPath(); x.moveTo(px, py - 7 * dpr); x.lineTo(px + 5 * dpr, py); x.lineTo(px, py + 7 * dpr); x.lineTo(px - 5 * dpr, py); x.fill();
        continue;
      }
      if (u.k === 'throne' || u.k === 'kobold') continue;
      const hero = u.k === 'hero' || u.k === 'illusion';
      const r = (hero ? 5 : u.k === 'fountain' ? 6 : 2.5) * dpr;
      x.fillStyle = u.t < 0 ? '#c9a24a' : this.ctx.teams[u.t]?.color ?? '#999';
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
      if (u.i === v.hero?.i) { x.strokeStyle = '#fff'; x.lineWidth = 2 * dpr; x.stroke(); }
    }
    if (corners.length === 4) {
      x.strokeStyle = '#ffffffcc'; x.lineWidth = 1.5 * dpr;
      x.beginPath();
      corners.forEach((p, i) => { const [px, py] = P(p.x, p.y); if (i) x.lineTo(px, py); else x.moveTo(px, py); });
      x.closePath(); x.stroke();
    }
  }

  private place(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    this.tip.style.display = 'block';
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = `${Math.max(8, Math.min(innerWidth - tw - 8, r.left + r.width / 2 - tw / 2))}px`;
    this.tip.style.top = `${Math.max(8, r.top - th - 10)}px`;
  }

  private showAbilityTip(el: HTMLElement, a: SAbility) {
    const d = ABILITIES[a.k];
    if (!d) return;
    const lvl = Math.max(1, a.l);
    const skip = /castpoint|castrange|tooltip|^max_|scepter|shard|^zero|visualz|zchange|^does_|^require|^no_|^dispel|^attack_factor$/;
    const vals = Object.entries(d.values).filter(([k, arr]) => !skip.test(k) && arr.some((x) => x !== 0)).slice(0, 8)
      .map(([k, arr]) => `<span class="k">${esc(k.replaceAll('_', ' '))}:</span> ${arr.length > 1 ? arr.map((x, i) => (i === lvl - 1 ? `<b>${x}</b>` : x)).join(' / ') : arr[0]}`).join('\n');
    const cd = d.cd.length ? `Enfriamiento: ${d.cd.join(' / ')}` : '';
    const mc = d.mc.length ? `Maná: ${d.mc.join(' / ')}` : '';
    this.tip.innerHTML = `<h4>${esc(d.name)}${a.ult ? ' (definitiva)' : a.innate ? ' (innata)' : ''}</h4>${esc(d.desc)}\n\n${vals}\n${[cd, mc].filter(Boolean).join('   ')}${a.rng ? `\nAlcance: ${a.rng}` : ''}`;
    this.place(el);
  }

  private showItemTip(el: HTMLElement, key: string | undefined, slot: number, cost?: number) {
    if (!key) return;
    const d = ITEMS[key];
    if (!d) return;
    const comps = d.components.length ? `\nReceta: ${d.components.map((c) => ITEMS[c]?.name ?? c).join(' + ')}${d.recipeCost ? ` + receta (${d.recipeCost})` : ''}` : '';
    const stats = Object.entries(d.values).filter(([k]) => k.startsWith('bonus_')).slice(0, 6).map(([k, v]) => `+${lv(v, 1)} ${STAT_ES[k] ?? k.slice(6).replaceAll('_', ' ')}`).join('\n');
    const pending = !isShopItem(key) ? '\n(Su efecto aún no está disponible en esta versión)' : '';
    this.tip.innerHTML = `<h4>${esc(d.name)}</h4><span class="cost">${cost ?? d.cost} oro</span>${comps}\n${esc(stats)}\n${esc(d.desc)}${pending}${slot >= 0 ? '\n\nArrastra para mover. Clic derecho en la base: vender.' : ''}`;
    this.place(el);
  }

  private hideTip() { this.tip.style.display = 'none'; }

  showEnd(winner: number, reason: string, board: BoardRow[], myTeam: number, onExit: () => void) {
    const w = this.ctx.teams[winner];
    const e = h('div', 'endscreen');
    const p = h('div', 'panel');
    p.innerHTML = `<h2 style="color:${w?.color}">${winner === myTeam ? 'Victoria' : `Gana ${esc(w?.name ?? '')}`}</h2><p class="hint">${esc(reason)}</p>`;
    const t = h('div', 'board open');
    t.style.position = 'static'; t.style.transform = 'none'; t.style.border = '0'; t.style.padding = '0';
    this.boardEl = t;
    this.updateBoard(board);
    const b = h('button', 'btn primary', 'Volver al menú');
    b.onclick = onExit;
    p.append(t, h('div', 'sep'), b);
    e.append(p);
    this.el.append(e);
  }

  dispose() { this.tip.remove(); this.el.remove(); }
}

/** Terreno pequeño para el minimapa. */
export function minimapTerrain(layout: import('../../../shared/maps').MapLayout, colors: string[]) {
  return terrainCanvas(layout, { trees: true, teamColors: colors });
}
