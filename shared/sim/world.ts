// El mundo: bucle de simulación a 30 ticks/s. No sabe nada de red ni de render.
import { HEROES, UNITS, type HeroData } from '../data';
import {
  HERO_KITS, available, castPointOf, castRangeOf, cooldownOf, isItem, makeAbility, manaCostOf, refreshPassive, syncAutoLevels,
} from './abilities';
import { launchAttack } from './combat';
import { deliverStash, syncItemPassives } from './items';
import { CELL, Grid, TREE } from './nav';
import type { AbilityInst, CastTarget, Fx, ItemInst, Order, Projectile } from './types';
import { ST } from './types';
import { Unit, type BaseStats } from './unit';

export const TICK = 1 / 30;
export const NEUTRAL = -1;
const ACQUIRE = 600;
const DAY_LENGTH = 300;

export interface TeamState {
  id: number;
  name: string;
  color: string;
  kills: number;
  fountain: { x: number; y: number };
  /** Orbes pendientes de reparto y contadores del modo. */
  data: Record<string, any>;
}

export interface Rules {
  tick(dt: number): void;
  onHeroKilled(victim: Unit, killer: Unit | null, assisters: Unit[]): void;
  onCreepKilled?(victim: Unit, killer: Unit | null): void;
}

export interface Zone {
  id: number;
  fx: string;
  x: number; y: number; r: number;
  team: number;
  interval: number;
  acc: number;
  until: number;
  onInterval(z: Zone): void;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function heroBase(h: HeroData): BaseStats {
  return {
    hp: h.hp, hpRegen: h.hpRegen, mana: h.mana, manaRegen: h.manaRegen,
    armor: h.armor, mr: h.mr, dmgMin: h.dmgMin, dmgMax: h.dmgMax,
    bat: h.bat, attackPoint: h.attackPoint, range: h.range, projSpeed: h.projSpeed,
    ms: h.ms, dayVision: h.dayVision, nightVision: h.nightVision, turnRate: h.turnRate || 0.6,
    melee: h.melee,
  };
}

const angDiff = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

export class World {
  time = 0;
  tickN = 0;
  units = new Map<number, Unit>();
  list: Unit[] = [];
  projectiles: Projectile[] = [];
  fx: Fx[] = [];
  teams: TeamState[] = [];
  rules: Rules | null = null;
  grid: Grid;
  rng: () => number;
  /** Visibilidad por equipo, recalculada cada pocos ticks. */
  visible = new Map<number, Set<number>>();
  private nextId = 1;
  private removals = new Map<Unit, number>();
  /** Mensajes de error para el jugador (sin maná, en enfriamiento…). */
  errors: { playerId: string; msg: string }[] = [];
  over: null | { winner: number; reason: string } = null;
  private timers: { at: number; fn: () => void }[] = [];
  /** Zonas persistentes (Shrapnel, ward de curación…): se dibujan como círculos. */
  zones: Zone[] = [];
  /** Visión sin unidad (Shrapnel, Assassinate, dust de Kunkka…). */
  visionSources: { team: number; x: number; y: number; r: number; until: number; flying: boolean }[] = [];

  constructor(grid: Grid, seed = 1) {
    this.grid = grid;
    this.rng = mulberry32(seed);
  }

  /** Ejecuta `fn` dentro de `delay` segundos de simulación. */
  after(delay: number, fn: () => void) { this.timers.push({ at: this.time + delay, fn }); }

  addZone(z: Omit<Zone, 'id' | 'acc' | 'until'> & { duration: number }) {
    const zone: Zone = { ...z, id: this.nextId++, acc: 0, until: this.time + z.duration };
    this.zones.push(zone);
    return zone;
  }

  addVision(team: number, x: number, y: number, r: number, duration: number, flying = true) {
    this.visionSources.push({ team, x, y, r, until: this.time + duration, flying });
  }

  /** Tala los árboles del radio; vuelven a crecer a los 5 minutos. Devuelve cuántos. */
  cutTrees(x: number, y: number, r: number): number {
    const g = this.grid;
    let n = 0;
    const c0x = g.cx(x - r), c1x = g.cx(x + r), c0y = g.cy(y - r), c1y = g.cy(y + r);
    for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
      if (g.cellAt(cx, cy) !== TREE) continue;
      if (Math.hypot(g.centerX(cx) - x, g.centerY(cy) - y) > r + CELL / 2) continue;
      if (g.cutTree(cx, cy, this.time, 300)) n++;
    }
    if (n) this.emit({ n: 'trees_cut', x, y, r });
    return n;
  }

  /** Árbol más cercano a un punto (para tango, Quelling Blade, Tree Grab…). */
  nearestTree(x: number, y: number, r: number): { x: number; y: number; cx: number; cy: number } | null {
    const g = this.grid;
    let best: { x: number; y: number; cx: number; cy: number } | null = null, bd = Infinity;
    const c0x = g.cx(x - r), c1x = g.cx(x + r), c0y = g.cy(y - r), c1y = g.cy(y + r);
    for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
      if (g.cellAt(cx, cy) !== TREE) continue;
      const px = g.centerX(cx), py = g.centerY(cy);
      const d = Math.hypot(px - x, py - y);
      if (d <= r && d < bd) { bd = d; best = { x: px, y: py, cx, cy }; }
    }
    return best;
  }

  /** Noche forzada hasta este instante (Dark Ascension, Eclipse con Scepter…). */
  nightUntil = 0;
  isNight() { return this.time < this.nightUntil || Math.floor(this.time / DAY_LENGTH) % 2 === 1; }
  emit(f: Fx) { this.fx.push(f); }
  error(u: Unit, msg: string) { if (u.playerId) this.errors.push({ playerId: u.playerId, msg }); }

  // ---------------- Altas y bajas ----------------

  addUnit(kind: Unit['kind'], name: string, team: number, base: BaseStats, x: number, y: number, hero: HeroData | null = null) {
    const p = this.grid.nearestFree(x, y);
    const u = new Unit(this, this.nextId++, kind, team, name, base, hero, p.x, p.y);
    this.units.set(u.id, u);
    this.list.push(u);
    return u;
  }

  spawnHero(key: string, team: number, playerId: string | null, x: number, y: number) {
    const h = HEROES[key];
    const u = this.addUnit('hero', key, team, heroBase(h), x, y, h);
    u.playerId = playerId;
    u.abilityPoints = 1;
    const kit = HERO_KITS[key] ?? [];
    kit.forEach((k, i) => {
      const a = makeAbility(u, k, i);
      if (a) u.abilities.push(a);
    });
    syncAutoLevels(u);
    for (const a of u.abilities) if (a.level > 0) refreshPassive(a);
    u.refreshStats();
    u.hp = u.s.maxHp; u.mana = u.s.maxMana;
    return u;
  }

  /** Ilusión de un héroe: mismos stats y pasivas, sin poder lanzar habilidades. */
  spawnIllusion(of: Unit, x: number, y: number, duration: number, outPct: number, inPct: number, owner: Unit | null = null) {
    const src = of.kind === 'illusion' ? (of.owner as Unit) ?? of : of;
    // Copia de la base: las transformaciones del héroe no deben alterar a sus ilusiones ya creadas.
    const u = this.addUnit('illusion', src.name, src.team, { ...src.base }, x, y, src.hero);
    u.owner = owner ?? src;
    u.playerId = src.playerId;
    u.level = src.level; u.xp = src.xp;
    u.permStr = src.permStr; u.permAgi = src.permAgi; u.permInt = src.permInt;
    u.facing = src.facing;
    u.talents = new Set(src.talents);
    u.shard = src.shard; u.blessing = src.blessing;
    for (const m of src.mods) if (m.name === 'talents' || m.name === 'orb_bonus') u.addMod({ ...m, name: m.name, data: { ...m.data } } as any, u, null);
    for (const a of src.abilities) {
      const c = makeAbility(u, a.key, a.slot);
      if (!c) continue;
      c.level = a.level;
      c.upg = { ...a.upg };
      u.abilities.push(c);
    }
    // Las ilusiones tienen las pasivas intrínsecas de todas las habilidades (Frost Arrows, Take Aim…).
    for (const a of u.abilities) if (a.impl.passive && !a.impl.noIllusion) refreshPassive(a);
    for (const s of [0, 1, 2, 3, 4, 5, 9]) {
      const it = src.items[s];
      if (!it) continue;
      u.items[s] = { ...it, owner: u, passiveMod: null, cd: 0, data: {} };
    }
    syncItemPassives(u);
    u.addMod({
      name: 'illusion', persistent: true,
      props: { outgoingPct: outPct, incomingPct: inPct },
      data: { src: src.id },
    }, src, null);
    u.expireAt = this.time + duration;
    u.hp = u.s.maxHp * (src.hp / src.s.maxHp);
    u.mana = src.mana;
    return u;
  }

  /**
   * Invocación controlable (oso de Lone Druid, treants, wards de Venomancer…).
   * `unit` es la clave de units.json (sin npc_dota_) o unos stats propios.
   */
  spawnSummon(owner: Unit, unit: string | BaseStats, x: number, y: number, duration = Infinity,
    opts: { name?: string; kind?: 'summon' | 'ward'; abilities?: string[]; level?: number; hp?: number; bounty?: number; xp?: number } = {}) {
    const d = typeof unit === 'string' ? UNITS[unit] : null;
    const base: BaseStats = typeof unit !== 'string' ? unit : d ? {
      hp: d.hp, hpRegen: d.hpRegen, mana: d.mana, manaRegen: d.manaRegen, armor: d.armor, mr: d.mr,
      dmgMin: d.dmgMin, dmgMax: d.dmgMax, bat: d.bat, attackPoint: d.attackPoint, range: d.range, projSpeed: d.projSpeed,
      ms: d.ms, dayVision: d.dayVision, nightVision: d.nightVision, turnRate: d.turnRate || 0.6, melee: d.melee,
    } : { hp: 300, hpRegen: 0, mana: 0, manaRegen: 0, armor: 0, mr: 0, dmgMin: 20, dmgMax: 25, bat: 1.5, attackPoint: 0.4,
      range: 100, projSpeed: 900, ms: 300, dayVision: 800, nightVision: 800, turnRate: 0.6, melee: true };
    if (opts.hp) base.hp = opts.hp;
    const u = this.addUnit(opts.kind ?? 'summon', opts.name ?? (typeof unit === 'string' ? unit : 'summon'), owner.team, base, x, y);
    u.owner = owner;
    u.playerId = owner.playerId;
    u.expireAt = this.time + duration;
    u.bountyGold = opts.bounty ?? d?.bountyGold ?? 0;
    u.bountyXp = opts.xp ?? d?.bountyXp ?? 0;
    if (d && !d.canAttack) u.addMod({ name: 'cannot_attack', persistent: true, states: ST.disarmed });
    if (d?.flying) u.addMod({ name: 'flying', persistent: true, states: ST.flying | ST.noCollision });
    const abil = opts.abilities ?? d?.abilities ?? [];
    abil.forEach((k) => {
      // El hueco es la posición real en la lista (las que no existen no dejan agujero).
      const a = makeAbility(u, k, u.abilities.length);
      if (!a) return;
      a.level = opts.level ?? Math.max(1, a.level);
      u.abilities.push(a);
    });
    for (const a of u.abilities) refreshPassive(a);
    u.facing = owner.facing;
    u.refreshStats();
    u.hp = u.s.maxHp; u.mana = u.s.maxMana;
    return u;
  }

  removeLater(u: Unit, delay: number) { this.removals.set(u, this.time + delay); }

  removeUnit(u: Unit) {
    if (!this.units.has(u.id)) return;
    for (const m of [...u.mods]) u.removeMod(m);
    this.units.delete(u.id);
    const i = this.list.indexOf(u);
    if (i >= 0) this.list.splice(i, 1);
    this.removals.delete(u);
  }

  // ---------------- Consultas ----------------

  dist(a: { x: number; y: number }, b: { x: number; y: number }) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /** Unidad con la que se puede interactuar (atacar, hechizar). */
  targetable(u: Unit | undefined | null): u is Unit {
    return !!u && u.alive && !u.has(ST.untargetable) && !u.has(ST.hidden) &&
      u.kind !== 'throne' && u.kind !== 'kobold' && u.kind !== 'orb';
  }

  canSee(team: number, u: Unit) {
    if (u.team === team) return true;
    return this.visible.get(team)?.has(u.id) ?? false;
  }

  unitsIn(x: number, y: number, r: number, pred?: (u: Unit) => boolean): Unit[] {
    const out: Unit[] = [];
    for (const u of this.list) {
      if (!u.alive) continue;
      const d = Math.hypot(u.x - x, u.y - y);
      if (d <= r + u.radius && (!pred || pred(u))) out.push(u);
    }
    return out;
  }

  /** Enemigos válidos para un área: incluye invisibles, excluye invulnerables y estructuras. */
  enemiesIn(team: number, x: number, y: number, r: number, opts: { heroes?: boolean; immune?: boolean } = {}) {
    return this.unitsIn(x, y, r, (u) => u.team !== team && this.targetable(u) &&
      !u.has(ST.invulnerable) && u.kind !== 'fountain' &&
      (!opts.heroes || u.isHeroLike) && (opts.immune !== false || !u.has(ST.magicImmune)));
  }

  alliesIn(team: number, x: number, y: number, r: number, opts: { heroes?: boolean } = {}) {
    return this.unitsIn(x, y, r, (u) => u.team === team && this.targetable(u) &&
      u.kind !== 'fountain' && (!opts.heroes || u.isHeroLike));
  }

  pointVisible(team: number, x: number, y: number) {
    for (const u of this.list) {
      if (u.team !== team || !u.alive) continue;
      if (Math.hypot(u.x - x, u.y - y) <= u.s.vision) return true;
    }
    for (const v of this.visionSources) if (v.team === team && Math.hypot(v.x - x, v.y - y) <= v.r) return true;
    return false;
  }

  // ---------------- Proyectiles ----------------

  addProjectile(p: Partial<Projectile> & Pick<Projectile, 'kind' | 'fx' | 'source' | 'x' | 'y' | 'speed' | 'onHit'>) {
    const proj: Projectile = {
      id: this.nextId++, target: null, dx: 0, dy: 0, left: 0, width: 0, widthEnd: 0,
      travelled: 0, hit: new Set(), dodgeable: false, team: p.source.team, dead: false,
      ...p,
    };
    this.projectiles.push(proj);
    return proj;
  }

  /** Esquivar: los proyectiles rastreadores esquivables contra `u` se pierden. */
  disjoint(u: Unit) {
    for (const p of this.projectiles) if (p.kind === 'track' && p.target === u && p.dodgeable) p.dead = true;
  }

  private stepProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (p.dead) continue;
      p.onThink?.(p, dt);
      if (p.dead) continue;
      if (p.kind === 'track') {
        const t = p.target as Unit | null;
        if (!t || !t.alive || t.has(ST.hidden)) { p.dead = true; continue; }
        const d = Math.hypot(t.x - p.x, t.y - p.y);
        const step = p.speed * dt;
        if (d <= step + t.radius) {
          p.x = t.x; p.y = t.y;
          p.onHit(p, t);
          p.dead = true;
        } else {
          p.x += (t.x - p.x) / d * step;
          p.y += (t.y - p.y) / d * step;
        }
      } else {
        const step = Math.min(p.speed * dt, p.left);
        p.x += p.dx * step; p.y += p.dy * step;
        p.left -= step; p.travelled += step;
        const total = p.travelled + p.left;
        const width = p.widthEnd && total > 0 ? p.width + (p.widthEnd - p.width) * (p.travelled / total) : p.width;
        for (const u of this.list) {
          if (p.dead) break;
          if (!this.targetable(u) || p.hit.has(u.id) || u === p.source) continue;
          if (Math.hypot(u.x - p.x, u.y - p.y) > width / 2 + u.radius) continue;
          p.hit.add(u.id);
          if (p.onHit(p, u)) p.dead = true;
        }
        if (p.left <= 0 && !p.dead) { p.dead = true; p.onEnd?.(p); }
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.dead);
  }

  // ---------------- Órdenes ----------------

  issueOrder(u: Unit, o: Order, queue = false) {
    if (!u.alive) return;
    if (o.type === 'cast' || o.type === 'item') {
      const a = o.type === 'cast' ? u.abilities[o.slot] : u.items[o.slot];
      if (!a) return;
      const err = this.castCheck(u, a);
      if (err) { this.error(u, err); return; }
      // Sin objetivo e instantáneas: se ejecutan sin cortar la orden actual.
      const tk = a.impl!.target;
      const cp = isItem(a) ? (a.impl!.castPoint ?? 0) : castPointOf(a);
      if (tk === 'toggle') { this.toggle(u, a); return; }
      if (tk === 'none' && cp === 0 && !(isItem(a) ? a.impl!.channel : (a as AbilityInst).impl.channel)) {
        this.executeCast(u, a, { x: u.x, y: u.y });
        return;
      }
    }
    for (const m of u.hooks()) m.onOrder?.(m, o);
    if (u.cast?.phase === 2) this.interruptCast(u, true);
    if (queue && (u.order || u.cast)) { u.queue.push(o); return; }
    u.order = o;
    u.queue = [];
    u.path = []; u.pathFor = '';
    if (u.cast?.phase === 1) u.cast = null;
    u.atk.phase = 0;
  }

  /** Comprueba si se puede lanzar ahora mismo (sin mirar alcance ni objetivo). */
  castCheck(u: Unit, a: AbilityInst | ItemInst): string | null {
    if (!a.impl) return 'Este item no tiene activa';
    if (a.impl.target === 'passive') return 'Es una pasiva';
    if (u.kind === 'illusion') return 'Las ilusiones no lanzan habilidades';
    if (u.has(ST.stunned) && !(!isItem(a) && a.impl.usableStunned?.(a))) return 'Aturdido';
    if (isItem(a)) {
      if (u.has(ST.muted)) return 'Silenciado (objetos)';
      if (a.slot >= 6 && a.slot !== 9) return 'Está en la mochila';
      if (a.cd > 0) return 'En enfriamiento';
      if (u.mana < a.def.mc) return 'Sin maná';
      const extra = a.impl.check?.(a);
      if (extra) return extra;
    } else {
      if (typeof a.impl.hidden === 'function' ? a.impl.hidden(a) : a.impl.hidden) return 'No disponible ahora';
      if (!available(a)) return a.impl.requires === 'shard' || a.def.grantedBy === 'shard' ? 'Necesitas el Aghanim\'s Shard' : 'Necesitas el Aghanim\'s Scepter';
      if (a.level <= 0) return 'Habilidad sin aprender';
      if (u.has(ST.silenced) || u.has(ST.hexed)) return 'Silenciado';
      if (a.impl.charges ? a.charges <= 0 : a.cd > 0) return 'En enfriamiento';
      if (u.mana < manaCostOf(a)) return 'Sin maná';
      const extra = a.impl.check?.(a);
      if (extra) return extra;
    }
    return null;
  }

  private targetCheck(u: Unit, a: AbilityInst | ItemInst, t: Unit | undefined): string | null {
    if (!this.targetable(t) || !this.canSee(u.team, t)) return 'Objetivo no válido';
    const team = a.impl!.team ?? 'enemy';
    if (t === u && !a.impl!.allowSelf && team !== 'ally' && team !== 'any') return 'No puedes lanzarlo sobre ti';
    if (team === 'enemy' && t.team === u.team) return 'Tiene que ser un enemigo';
    if (team === 'ally' && t.team !== u.team) return 'Tiene que ser un aliado';
    if (t.team !== u.team && t.has(ST.magicImmune) && !(!isItem(a) && a.def.bkbPierce) && !a.data.pierce) return 'Inmune a hechizos';
    if (t.has(ST.invulnerable) && t.team !== u.team) return 'Invulnerable';
    return null;
  }

  private toggle(u: Unit, a: AbilityInst | ItemInst) {
    a.toggled = !a.toggled;
    a.impl!.onToggle?.(a as any, a.toggled);
    if (!isItem(a) && a.toggled) for (const m of u.hooks()) m.onAbilityExecuted?.(m, a);
  }

  executeCast(u: Unit, a: AbilityInst | ItemInst, t: CastTarget) {
    if (isItem(a)) {
      u.mana -= a.def.mc * (1 - u.s.manaReduce);
      a.cd = a.def.cd * (1 - u.s.cdr);
    } else {
      u.mana -= manaCostOf(a);
      if (a.impl.charges) {
        if (a.charges === a.impl.charges(a)[0]) a.chargeCd = a.impl.charges(a)[1] * a.upg.cd;
        a.charges--;
      } else a.cd = cooldownOf(a);
    }
    // Invisibilidad: lanzar la rompe.
    for (const m of [...u.mods]) if (m.data.breaksOnAttack && !a.data.keepInvis) m.data.breakNow = true;
    // Bloqueo y reflejo (Counterspell, Linken…).
    const tu = t.unit as Unit | undefined;
    if (tu && tu.team !== u.team && a.impl!.reflectable !== false) {
      for (const m of tu.hooks()) {
        if (m.onTargeted?.(m, u, a)) { this.afterCast(u, a); return; }
      }
    }
    a.impl!.onSpellStart?.(a as any, t);
    this.afterCast(u, a);
  }

  private afterCast(u: Unit, a: AbilityInst | ItemInst) {
    for (const m of u.hooks()) m.onAbilityExecuted?.(m, a);
    if (!isItem(a)) {
      for (const e of this.enemiesIn(u.team, u.x, u.y, 1200, { heroes: true })) {
        for (const m of e.hooks()) m.data.onEnemyCast?.(m);
      }
    }
  }

  interruptCast(u: Unit, interrupted: boolean) {
    const c = u.cast;
    if (!c) return;
    u.cast = null;
    if (c.phase === 2) {
      u.removeModsByName('channeling');
      (c.a.impl as any)?.onChannelEnd?.(c.a, interrupted);
    }
  }

  private channelOf(a: AbilityInst | ItemInst) {
    return a.impl?.channel ? a.impl.channel(a as any) : 0;
  }

  private stepCast(u: Unit, dt: number) {
    const c = u.cast!;
    const a = c.a;
    const stunOk = !isItem(a) && !!a.impl.usableStunned?.(a);
    if ((u.has(ST.stunned) && !stunOk) || u.has(ST.hidden) || (!isItem(a) && (u.has(ST.silenced) || u.has(ST.hexed))) ||
        (isItem(a) && u.has(ST.muted))) {
      this.interruptCast(u, true);
      return;
    }
    const tu = c.tu ? this.units.get(c.tu) : undefined;
    if (c.phase === 1) {
      if (c.tu && !this.targetable(tu)) { u.cast = null; u.order = null; return; }
      const tx = tu ? tu.x : c.tx, ty = tu ? tu.y : c.ty;
      const needFace = a.impl!.target !== 'none';
      if (needFace && !(tx === u.x && ty === u.y)) {
        if (!this.turnTo(u, Math.atan2(ty - u.y, tx - u.x), dt)) return;
      }
      c.t += dt;
      const cp = isItem(a) ? (a.impl!.castPoint ?? 0) : castPointOf(a);
      if (c.t < cp) return;
      // Revalida al final del cast point.
      const err = this.castCheck(u, a);
      if (err) { this.error(u, err); u.cast = null; u.order = null; return; }
      const ch = this.channelOf(a);
      this.executeCast(u, a, { unit: tu, x: tx, y: ty });
      if (ch > 0 && u.alive) {
        c.phase = 2; c.t = 0; c.channel = ch;
        u.addMod({ name: 'channeling', duration: ch, states: ST.channeling });
      } else {
        u.cast = null;
      }
      u.order = null;
      return;
    }
    c.t += dt;
    (a.impl as any).onChannelTick?.(a, dt);
    if (u.cast && c.t >= c.channel) {
      u.cast = null;
      u.removeModsByName('channeling');
      (a.impl as any).onChannelEnd?.(a, false);
    }
  }

  // ---------------- Movimiento ----------------

  turnTo(u: Unit, angle: number, dt: number): boolean {
    const d = angDiff(u.facing, angle);
    const w = (u.base.turnRate / 0.03) * dt;
    if (Math.abs(d) <= w) u.facing = angle;
    else u.facing += Math.sign(d) * w;
    return Math.abs(angDiff(u.facing, angle)) < 0.2;
  }

  /** Avanza hacia (tx,ty); true al llegar a menos de `stop`. */
  moveToward(u: Unit, tx: number, ty: number, dt: number, stop = 8): boolean {
    const d = Math.hypot(tx - u.x, ty - u.y);
    if (d <= stop) { u.path = []; return true; }
    if (u.has(ST.rooted)) return false;
    const key = `${Math.round(tx / 48)},${Math.round(ty / 48)}`;
    if (key !== u.pathFor || !u.path.length || (u.data_repathAt ?? 0) <= this.time) {
      u.path = this.grid.findPath(u.x, u.y, tx, ty);
      u.pathFor = key;
      u.data_repathAt = this.time + 0.5;
      if (!u.path.length) return true;
    }
    let budget = u.s.ms * dt;
    while (budget > 0 && u.path.length) {
      const p = u.path[0];
      const pd = Math.hypot(p.x - u.x, p.y - u.y);
      const ang = Math.atan2(p.y - u.y, p.x - u.x);
      this.turnTo(u, ang, dt);
      if (pd <= budget) {
        this.tryMove(u, p.x, p.y);
        budget -= pd;
        u.path.shift();
      } else {
        this.tryMove(u, u.x + (p.x - u.x) / pd * budget, u.y + (p.y - u.y) / pd * budget);
        budget = 0;
      }
      if (Math.hypot(tx - u.x, ty - u.y) <= stop) return true;
    }
    return Math.hypot(tx - u.x, ty - u.y) <= stop;
  }

  private tryMove(u: Unit, x: number, y: number) {
    const g = this.grid;
    if (g.walkable(x, y)) { u.x = x; u.y = y; }
    else if (g.walkable(x, u.y)) u.x = x;
    else if (g.walkable(u.x, y)) u.y = y;
  }

  /** Movimiento forzado (empujones, ganchos); termina en suelo libre. */
  forceMove(u: Unit, x: number, y: number) {
    const g = this.grid;
    if (g.walkable(x, y)) { u.x = x; u.y = y; }
    else { const p = g.nearestFree(x, y); u.x = p.x; u.y = p.y; }
  }

  /** Teletransporte a un punto libre. */
  teleport(u: Unit, x: number, y: number) {
    const p = this.grid.nearestFree(x, y);
    u.x = p.x; u.y = p.y; u.path = []; u.pathFor = '';
  }

  private separate() {
    const L = this.list.filter((u) => u.alive && (u.isHeroLike || u.kind === 'creep' || u.kind === 'ward') &&
      !u.has(ST.noCollision) && !u.has(ST.hidden));
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const min = (a.radius + b.radius) * 0.8;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 0.01;
      const push = (min - d) / 2;
      const nx = d2 ? dx / d : 1, ny = d2 ? dy / d : 0;
      if (!a.has(ST.rooted) && !a.has(ST.stunned)) this.tryMove(a, a.x - nx * push, a.y - ny * push);
      if (!b.has(ST.rooted) && !b.has(ST.stunned)) this.tryMove(b, b.x + nx * push, b.y + ny * push);
    }
  }

  // ---------------- Pensamiento de cada unidad ----------------

  private attackTarget(u: Unit, t: Unit, dt: number): 'ok' | 'invalid' {
    if (!this.targetable(t) || t.team === u.team || !this.canSee(u.team, t) || t.has(ST.invulnerable) && t.kind !== 'fountain') {
      u.atk.phase = 0;
      return 'invalid';
    }
    const range = u.s.attackRange + u.radius + t.radius;
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    if (u.atk.phase === 1) {
      if (d > range + 250 || u.has(ST.disarmed)) { u.atk.phase = 0; return 'ok'; }
      this.turnTo(u, Math.atan2(t.y - u.y, t.x - u.x), dt);
      u.atk.t += dt;
      if (u.atk.t >= u.attackPointTime()) {
        u.atk.phase = 0;
        u.atk.cd = u.attackInterval();
        launchAttack(u, t);
      }
      return 'ok';
    }
    if (d > range) {
      if (u.kind === 'fountain') return 'invalid';
      this.moveToward(u, t.x, t.y, dt, range - 4);
      return 'ok';
    }
    u.path = [];
    const faced = this.turnTo(u, Math.atan2(t.y - u.y, t.x - u.x), dt);
    if (faced && u.atk.cd <= 0 && !u.has(ST.disarmed)) {
      u.atk.phase = 1; u.atk.t = 0; u.atk.target = t.id;
    }
    return 'ok';
  }

  /** Enemigo más cercano visible en el radio de adquisición. */
  acquire(u: Unit, r = ACQUIRE): Unit | null {
    let best: Unit | null = null, bd = Infinity;
    for (const e of this.list) {
      if (e.team === u.team || !this.targetable(e) || e.has(ST.invulnerable) || e.kind === 'fountain') continue;
      if (!this.canSee(u.team, e)) continue;
      if (e.team === NEUTRAL && u.kind !== 'fountain' && u.isHeroLike && !u.order) continue;
      const d = Math.hypot(e.x - u.x, e.y - u.y);
      if (d < r && d < bd) { bd = d; best = e; }
    }
    return best;
  }

  private think(u: Unit, dt: number) {
    if (u.cast) { this.stepCast(u, dt); if (u.cast) return; }
    if (u.has(ST.stunned) || u.has(ST.hidden)) { u.atk.phase = 0; return; }
    // Miedo: huye del origen sin obedecer órdenes.
    const fear = u.mods.find((m) => m.data.fearFrom);
    if (fear) {
      const f = fear.data.fearFrom as { x: number; y: number };
      const d = Math.hypot(u.x - f.x, u.y - f.y) || 1;
      u.atk.phase = 0;
      this.moveToward(u, u.x + (u.x - f.x) / d * 300, u.y + (u.y - f.y) / d * 300, dt, 4);
      return;
    }
    const taunt = u.mods.find((m) => m.name === 'taunt');
    if (taunt && taunt.caster) {
      this.attackTarget(u, taunt.caster as Unit, dt);
      return;
    }
    if (!u.order && u.queue.length) u.order = u.queue.shift()!;
    const o = u.order;
    if (!o) {
      if (u.kind === 'creep' && u.team === NEUTRAL) return this.thinkNeutral(u, dt);
      if (u.kind === 'ward' || u.kind === 'orb' || u.kind === 'kobold' || u.kind === 'throne') return;
      const t = this.units.get(u.atk.target);
      if (t && u.data_autoUntil > this.time && this.attackTarget(u, t, dt) === 'ok') return;
      const e = this.acquire(u, u.kind === 'fountain' ? u.s.attackRange : ACQUIRE);
      if (e) { u.atk.target = e.id; u.data_autoUntil = this.time + 2; this.attackTarget(u, e, dt); }
      return;
    }
    switch (o.type) {
      case 'move':
        if (this.moveToward(u, o.x, o.y, dt)) u.order = null;
        break;
      case 'attackMove': {
        const e = this.acquire(u);
        if (e) { this.attackTarget(u, e, dt); break; }
        if (this.moveToward(u, o.x, o.y, dt)) u.order = null;
        break;
      }
      case 'attack': {
        const t = this.units.get(o.target);
        if (!t || this.attackTarget(u, t, dt) === 'invalid') u.order = null;
        break;
      }
      case 'follow': {
        const t = this.units.get(o.target);
        if (!t || !t.alive) { u.order = null; break; }
        this.moveToward(u, t.x, t.y, dt, 120);
        break;
      }
      case 'stop': u.order = null; u.atk.phase = 0; break;
      case 'hold': u.atk.phase = 0; {
        const e = this.acquire(u, u.s.attackRange + 50);
        if (e) this.attackTarget(u, e, dt);
      } break;
      case 'cast':
      case 'item':
        this.thinkCastOrder(u, o, dt);
        break;
    }
  }

  private thinkCastOrder(u: Unit, o: Extract<Order, { type: 'cast' | 'item' }>, dt: number) {
    const a = o.type === 'cast' ? u.abilities[o.slot] : u.items[o.slot];
    if (!a || !a.impl) { u.order = null; return; }
    const err = this.castCheck(u, a);
    if (err) { this.error(u, err); u.order = null; return; }
    const kind = a.impl.target;
    let tu: Unit | undefined;
    let tx = u.x, ty = u.y;
    if (kind === 'unit' || (kind === 'unitOrPoint' && o.target)) {
      tu = o.target ? this.units.get(o.target) : undefined;
      const e2 = this.targetCheck(u, a, tu);
      if (e2) { this.error(u, e2); u.order = null; return; }
      tx = tu!.x; ty = tu!.y;
    } else if (kind === 'point' || kind === 'unitOrPoint') {
      tx = o.x ?? u.x; ty = o.y ?? u.y;
    }
    if (kind !== 'none') {
      const range = isItem(a) ? (a.impl.castRange ? a.impl.castRange(a) : 0) + u.s.castRange : castRangeOf(a);
      const extra = tu ? tu.radius + u.radius : 0;
      const d = Math.hypot(tx - u.x, ty - u.y);
      // Blink: más allá del alcance se lanza igual (lo recorta la propia habilidad).
      if (range > 0 && d > range + extra && !a.data.castBeyond && !(a.impl as any).castBeyond) {
        this.moveToward(u, tx, ty, dt, range + extra - 8);
        return;
      }
    }
    u.path = [];
    u.cast = { a, tu: tu?.id ?? 0, tx, ty, phase: 1, t: 0, channel: 0 };
    this.stepCast(u, dt);
  }

  /** Creeps neutrales: quietos hasta que les pegan; vuelven al campamento si se alejan. */
  private thinkNeutral(u: Unit, dt: number) {
    const home = u.home ?? { x: u.x, y: u.y };
    const t = this.units.get(u.atk.target);
    const angry = t && t.alive && this.time - u.lastHeroDamageAt < 6 && this.targetable(t);
    if (angry && Math.hypot(u.x - home.x, u.y - home.y) < 900) {
      this.attackTarget(u, t, dt);
      return;
    }
    u.atk.phase = 0;
    if (Math.hypot(u.x - home.x, u.y - home.y) > 40) this.moveToward(u, home.x, home.y, dt, 30);
    else if (u.hp < u.s.maxHp) u.hp = Math.min(u.s.maxHp, u.hp + u.s.maxHp * 0.05 * dt);
  }

  // ---------------- Tick ----------------

  private tickMods(u: Unit, dt: number) {
    let changed = false;
    for (const m of u.hooks()) {
      if (!u.mods.includes(m)) continue;
      m.onTick?.(m, dt);
      if (m.interval && m.onInterval) {
        m.acc = (m.acc ?? 0) + dt;
        while (m.acc >= m.interval && u.mods.includes(m)) { m.acc -= m.interval; m.onInterval(m); }
      }
      if (m.aura && u.alive && (this.tickN % 6 === 0)) this.applyAura(u, m);
      if (m.data.breakNow) { u.removeMod(m); changed = true; continue; }
      if (Number.isFinite(m.remaining)) {
        m.remaining -= dt;
        if (m.remaining <= 0) { u.removeMod(m); changed = true; }
      }
    }
    if (changed) u.refreshStats();
  }

  private applyAura(u: Unit, m: import('./types').Modifier) {
    const a = m.aura!;
    const pred = (t: Unit) => (a.team === 'ally' ? t.team === u.team : t.team !== u.team) &&
      (!a.heroesOnly || t.isHeroLike) && (a.includeSelf !== false || t !== u) &&
      t.kind !== 'fountain' && t.kind !== 'throne' && t.kind !== 'kobold' && t.kind !== 'orb' && !t.has(ST.hidden);
    const targets = a.global ? this.list.filter((t) => t.alive && pred(t)) : this.unitsIn(u.x, u.y, a.radius, pred);
    for (const t of targets) {
      const spec = a.apply(m, t);
      t.addMod({ duration: 0.5, ...spec }, u, m.ability);
    }
  }

  tick() {
    const dt = TICK;
    this.time += dt;
    this.tickN++;
    for (const u of this.list) {
      if (!u.alive) {
        if (u.kind === 'hero' && u.respawnAt <= this.time) this.respawn(u);
        continue;
      }
      this.tickMods(u, dt);
      if (!u.alive) continue;
      u.hp = Math.min(u.s.maxHp, u.hp + u.s.hpRegen * dt);
      u.mana = Math.min(u.s.maxMana, u.mana + u.s.manaRegen * dt);
      u.atk.cd -= dt;
      for (const a of u.abilities) {
        if (a.cd > 0) a.cd = Math.max(0, a.cd - dt);
        if (a.impl.charges && a.level > 0) {
          const [max, every] = a.impl.charges(a);
          if (a.charges < max) {
            a.chargeCd -= dt;
            if (a.chargeCd <= 0) { a.charges++; a.chargeCd = a.charges < max ? every * a.upg.cd : 0; }
          }
        }
      }
      for (const it of u.items) if (it && it.cd > 0) it.cd = Math.max(0, it.cd - dt);
      if (u.expireAt <= this.time) { u.hp = 0; u.alive = false; this.emit({ n: 'death', x: u.x, y: u.y, u: u.id }); this.removeLater(u, 0.3); }
    }
    for (const u of [...this.list]) if (u.alive && !u.has(ST.busy)) this.think(u, dt);
    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= this.time);
      this.timers = this.timers.filter((t) => t.at > this.time);
      for (const t of due) t.fn();
    }
    for (const z of this.zones) {
      z.acc += dt;
      while (z.acc >= z.interval) { z.acc -= z.interval; z.onInterval(z); }
    }
    this.zones = this.zones.filter((z) => z.until > this.time);
    this.stepProjectiles(dt);
    this.separate();
    if (this.tickN % 15 === 0) for (const u of this.list) if (u.kind === 'hero') deliverStash(u);
    for (const [u, t] of this.removals) if (t <= this.time) this.removeUnit(u);
    if (this.tickN % 30 === 0 && this.grid.regrow(this.time)) {
      // Nadie se queda atrapado dentro de un árbol que vuelve a crecer.
      for (const u of this.list) if (!this.grid.walkable(u.x, u.y)) this.teleport(u, u.x, u.y);
    }
    this.rules?.tick(dt);
    if (this.tickN % 3 === 0) this.computeVision();
  }

  respawn(u: Unit) {
    const f = this.teams[u.team]?.fountain ?? { x: 0, y: 0 };
    this.teleport(u, f.x + (this.rng() - 0.5) * 200, f.y + (this.rng() - 0.5) * 200);
    u.alive = true;
    u.refreshStats();
    u.hp = u.s.maxHp; u.mana = u.s.maxMana;
    u.order = null; u.cast = null; u.atk.phase = 0;
    for (const a of u.abilities) refreshPassive(a);
    syncItemPassives(u);
    this.emit({ n: 'respawn', x: u.x, y: u.y, u: u.id });
    if (u.isHero) for (const m of u.mods) m.onRespawn?.(m);
  }

  computeVision() {
    this.visionSources = this.visionSources.filter((v) => v.until > this.time);
    const g = this.grid;
    for (const t of this.teams) {
      const set = new Set<number>();
      const eyes = this.list.filter((u) => u.team === t.id && u.alive && !u.has(ST.hidden));
      const sources = this.visionSources.filter((v) => v.team === t.id);
      const sight = eyes.filter((e) => e.s.trueSight > 0);
      for (const u of this.list) {
        if (u.team === t.id || u.kind === 'throne' || u.kind === 'kobold' || u.kind === 'fountain' || u.kind === 'orb') { set.add(u.id); continue; }
        if (!u.alive || (u.has(ST.hidden) && !u.has(ST.revealed))) continue;
        if (u.has(ST.invisible) && !u.has(ST.revealed) && !sight.some((e) => Math.hypot(e.x - u.x, e.y - u.y) <= e.s.trueSight)) continue;
        if (u.mods.some((m) => m.name === 'reveal' && m.data.team === t.id)) { set.add(u.id); continue; }
        let seen = false;
        for (const e of eyes) {
          if (Math.hypot(e.x - u.x, e.y - u.y) > e.s.vision) continue;
          // Los árboles tapan la visión de quien no vuela.
          if (e.has(ST.flying) || g.sightClear(e.x, e.y, u.x, u.y)) { seen = true; break; }
        }
        if (!seen) for (const v of sources) {
          if (Math.hypot(v.x - u.x, v.y - u.y) <= v.r && (v.flying || g.sightClear(v.x, v.y, u.x, u.y))) { seen = true; break; }
        }
        if (seen) set.add(u.id);
      }
      this.visible.set(t.id, set);
    }
  }

}
