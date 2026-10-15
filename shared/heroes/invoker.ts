import { defineAbility, defineHero, hasScepter, makeAbility, manaCostOf, val } from '../sim/abilities';
import { burnMana, damage, giveMana } from '../sim/combat';
import type { AbilityImpl, AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { currentTarget, distToSegment, nearestEnemyHero, ready, summonFollow } from './lib/a4';
import { castDir, debuff, push, slow, stun } from './util';

// Invoker: tres orbes (Quas, Wex, Exort) cuyas instancias activas dan bonos y deciden qué hechizo
// crea Invoke. Los dos hechizos invocados ocupan los huecos 3 y 4 (se sustituyen en u.abilities);
// los demás se guardan en el Invoke con su enfriamiento corriendo.

type Orb = 'q' | 'w' | 'e';
const ORB_SLOT: Record<Orb, number> = { q: 0, w: 1, e: 2 };
const INVOKE = 5;

/** Combinación de orbes (ordenada) → hechizo. */
const SPELLS: Record<string, string> = {
  qqq: 'invoker_cold_snap', qqw: 'invoker_ghost_walk', eqq: 'invoker_ice_wall',
  www: 'invoker_emp', qww: 'invoker_tornado', eww: 'invoker_alacrity',
  eee: 'invoker_sun_strike', eeq: 'invoker_forge_spirit', eew: 'invoker_chaos_meteor',
  eqw: 'invoker_deafening_blast',
};
const COMBO: Record<string, string> = Object.fromEntries(Object.entries(SPELLS).map(([k, v]) => [v, k]));

const invokeOf = (u: Unit) => u.abilities[INVOKE];
const orbsOf = (u: Unit): Orb[] => invokeOf(u)?.data.orbs ?? [];

/** Nivel efectivo de un orbe (Aghanim's Scepter suma uno). */
function orbLevel(u: Unit, o: Orb): number {
  const src = u.kind === 'illusion' && u.owner ? (u.owner as Unit) : u;
  const a = src.abilities[ORB_SLOT[o]];
  if (!a || a.level <= 0) return 0;
  return a.level + val(a, 'scepter_bonus_levels');
}

/** Valor de un hechizo invocado al nivel del orbe que lo gobierna. */
function ov(a: AbilityInst, key: string, o: Orb): number {
  const saved = a.level;
  a.level = Math.max(1, orbLevel(a.owner as Unit, o));
  const v = val(a, key);
  a.level = saved;
  return v;
}

// ---------------- Orbes ----------------

function orbAbility(key: string, o: Orb, attr: 'str' | 'agi' | 'int', bonusKey: string) {
  defineAbility({
    key, target: 'none', sub: false,
    passive: (a) => {
      a.data.keepInvis = true;
      return { name: key + '_passive', props: { [attr]: val(a, bonusKey) * orbLevel(a.owner as Unit, o) } };
    },
    onSpellStart(a) {
      const u = a.owner as Unit;
      const inv = invokeOf(u);
      if (!inv) return;
      const orbs: Orb[] = inv.data.orbs ??= [];
      orbs.push(o);
      if (orbs.length > 3) orbs.shift();
      u.refreshStats();
      u.w.emit({ n: 'invoker_orb', x: u.x, y: u.y, u: u.id, c: o });
    },
  });
}
orbAbility('invoker_quas', 'q', 'str', 'strength_bonus');
orbAbility('invoker_wex', 'w', 'agi', 'agility_bonus');
orbAbility('invoker_exort', 'e', 'int', 'intelligence_bonus');

// Huecos vacíos hasta la primera invocación.
for (const k of ['invoker_empty1', 'invoker_empty2']) defineAbility({ key: k, target: 'passive', sub: true });

/** Pone `key` en el hueco 3 (el anterior baja al 4 y el del 4 se guarda). */
function placeSpell(u: Unit, key: string): boolean {
  const inv = invokeOf(u);
  const store: Record<string, AbilityInst> = inv.data.store ??= {};
  const s3 = u.abilities[3], s4 = u.abilities[4];
  if (s3.key === key) return false;
  let inst: AbilityInst | null;
  if (s4.key === key) inst = s4;
  else {
    inst = store[key] ?? makeAbility(u, key, 3);
    if (!inst) return false;
    delete store[key];
    if (!s4.key.startsWith('invoker_empty')) store[s4.key] = s4;
  }
  inst.level = 1;
  inst.slot = 3; s3.slot = 4;
  u.abilities[3] = inst; u.abilities[4] = s3;
  return true;
}

defineAbility({
  key: 'invoker_invoke', target: 'none', ult: true, innate: true,
  passive: (a) => {
    a.data.keepInvis = true;
    return {
      name: 'invoker_orbs',
      props: () => {
        const u = a.owner as Unit;
        const n = { q: 0, w: 0, e: 0 } as Record<Orb, number>;
        for (const o of orbsOf(u)) n[o]++;
        const lvl = (o: Orb) => orbLevel(u, o);
        const orbA = (o: Orb) => (u.kind === 'illusion' && u.owner ? (u.owner as Unit) : u).abilities[ORB_SLOT[o]];
        const per = (o: Orb, k: string) => (lvl(o) > 0 ? ov(orbA(o), k, o) : 0);
        return {
          hpRegen: n.q * per('q', 'hp_regen_per_instance'),
          msPct: n.w * per('w', 'move_speed_per_instance') / 100,
          attackSpeed: n.w * per('w', 'attack_speed_per_instance'),
          damage: n.e * per('e', 'bonus_damage_per_instance'),
        };
      },
      onTick(m, dt) {
        const u = m.owner as Unit;
        // Los hechizos guardados siguen enfriándose.
        for (const s of Object.values((a.data.store ?? {}) as Record<string, AbilityInst>)) if (s.cd > 0) s.cd = Math.max(0, s.cd - dt);
        m.data.t = (m.data.t ?? 0) - dt;
        if (m.data.t > 0) return;
        m.data.t = 0.3;
        if (u.isBot && u.kind === 'hero' && u.alive && !u.cast) invokerBot(u, a);
      },
    };
  },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const orbs = orbsOf(u);
    if (orbs.length < 3) { a.cd = 0; return; }
    const key = SPELLS[[...orbs].sort().join('')];
    if (!key || !placeSpell(u, key)) { a.cd = 0; return; }
    const sum = (['q', 'w', 'e'] as Orb[]).reduce((s, o) => s + orbLevel(u, o), 0);
    a.cd = Math.max(0, val(a, '_cd') - val(a, 'cooldown_reduction_per_orb') * sum) * a.upg.cd * (1 - u.s.cdr);
    u.w.emit({ n: 'invoke', x: u.x, y: u.y, u: u.id });
  },
});

// ---------------- IA del bot ----------------

function press(u: Unit, combo: string) {
  for (const o of combo) u.w.issueOrder(u, { type: 'cast', slot: ORB_SLOT[o as Orb] });
}

function invokerBot(u: Unit, inv: AbilityInst) {
  const w = u.w;
  const store = (inv.data.store ?? {}) as Record<string, AbilityInst>;
  const slotOf = (k: string) => (u.abilities[3].key === k ? 3 : u.abilities[4].key === k ? 4 : -1);
  const inst = (k: string) => { const s = slotOf(k); return s >= 0 ? u.abilities[s] : (store[k] ??= makeAbility(u, k, 3)!); };
  const learned = (['q', 'w', 'e'] as Orb[]).filter((o) => u.abilities[ORB_SLOT[o]].level > 0);
  if (!learned.length) return;
  const canInvoke = !w.castCheck(u, inv);
  const t = currentTarget(u) ?? nearestEnemyHero(u, 1200);
  const hpPct = u.hp / u.s.maxHp;
  const tryInvoke = (k: string) => {
    if (slotOf(k) >= 0) return true;
    if (!canInvoke) return false;
    const combo = COMBO[k];
    if ([...combo].some((o) => u.abilities[ORB_SLOT[o as Orb]].level <= 0)) return false;
    press(u, combo);
    w.issueOrder(u, { type: 'cast', slot: INVOKE });
    return slotOf(k) >= 0;
  };
  // Huida: Ghost Walk.
  if (hpPct < 0.3 && t && Math.hypot(t.x - u.x, t.y - u.y) < 900 && !u.findMod('ghost_walk')) {
    const g = inst('invoker_ghost_walk');
    if (g.cd <= 0 && u.mana >= manaCostOf(g) && tryInvoke('invoker_ghost_walk')) {
      w.issueOrder(u, { type: 'cast', slot: slotOf('invoker_ghost_walk') });
      press(u, 'qqq');
      return;
    }
  }
  if (!t || Math.hypot(t.x - u.x, t.y - u.y) > 1300) {
    if (orbsOf(u).join('') !== 'www' && learned.includes('w') && hpPct > 0.5) press(u, 'www');
    return;
  }
  // Alacrity sobre sí mismo.
  const al = slotOf('invoker_alacrity');
  if (al >= 0 && ready(u.abilities[al])) { w.issueOrder(u, { type: 'cast', slot: al, target: u.id }); return; }
  const prio = ['invoker_tornado', 'invoker_cold_snap', 'invoker_emp', 'invoker_chaos_meteor', 'invoker_sun_strike',
    'invoker_deafening_blast', 'invoker_alacrity', 'invoker_forge_spirit', 'invoker_ice_wall'];
  if (canInvoke) {
    for (const k of prio) {
      if (slotOf(k) >= 0) continue;
      const s = inst(k);
      if (!s || s.cd > 0 || u.mana < manaCostOf(s)) continue;
      if (k === 'invoker_ice_wall' && Math.hypot(t.x - u.x, t.y - u.y) > 400) continue;
      // No sustituye un hechizo listo del hueco 3 si aún puede lanzarse.
      if (tryInvoke(k)) { press(u, learned.includes('e') ? 'eee' : learned[0].repeat(3)); return; }
    }
  }
  const want = learned.includes('e') ? 'eee' : learned[0].repeat(3);
  if (orbsOf(u).join('') !== want) press(u, want);
}

// ---------------- Hechizos invocados ----------------

function spell(impl: AbilityImpl) {
  return defineAbility({ sub: true, ...impl });
}

spell({
  key: 'invoker_cold_snap', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const fd = val(a, 'freeze_duration');
    const fdmg = ov(a, 'freeze_damage', 'q');
    const fcd = ov(a, 'freeze_cooldown', 'q');
    const trig = val(a, 'damage_trigger');
    const heal = val(a, 'freeze_heal');
    const freeze = (m: { data: Record<string, any> }) => {
      m.data.next = u.w.time + fcd;
      stun(u, e, fd, a);
      damage(u, e, fdmg, 'magical', a, { data: { coldSnap: true } });
      if (heal > 0) u.hp = Math.min(u.s.maxHp, u.hp + fdmg * heal);
    };
    const m = debuff(u, e, a, {
      name: 'cold_snap', duration: ov(a, 'duration', 'q'), fx: 'cold_snap', data: { next: 0 },
      onTakeDamage(mm, ev) {
        if (ev.data?.coldSnap || ev.amount < trig || u.w.time < mm.data.next) return;
        freeze(mm);
      },
    });
    if (m) freeze(m);
  },
});

spell({
  key: 'invoker_ghost_walk', target: 'none',
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'area_of_effect');
    const shard = val(a, 'apply_ice_wall_debuff') > 0;
    const store = (invokeOf(u)?.data.store ?? {}) as Record<string, AbilityInst>;
    const wall = store.invoker_ice_wall ?? (u.abilities[3].key === 'invoker_ice_wall' ? u.abilities[3] : u.abilities[4].key === 'invoker_ice_wall' ? u.abilities[4] : null);
    u.addMod({
      name: 'ghost_walk', duration: val(a, 'duration'), fx: 'ghost_walk', states: ST.invisible,
      data: { breaksOnAttack: true },
      props: {
        hpRegen: ov(a, 'health_regen', 'q'), manaRegen: ov(a, 'mana_regen', 'w'),
        msPct: Math.max(0, ov(a, 'self_slow', 'w')) / 100, msSlow: Math.max(0, -ov(a, 'self_slow', 'w')) / 100,
      },
      interval: 0.5,
      aura: {
        radius: r, team: 'enemy',
        apply: () => ({ name: 'ghost_walk_slow', debuff: true, fx: 'slow', duration: val(a, 'aura_fade_time'),
          props: { msSlow: Math.abs(ov(a, 'enemy_slow', 'q')) / 100 } }),
      },
      // Shard: los enemigos del aura sufren el frío del Ice Wall.
      onInterval() {
        if (!shard) return;
        const dps = wall ? ov(wall, 'damage_per_second', 'e') : 0;
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) if (dps > 0) damage(u, e, dps * 0.5, 'magical', a, { noProc: true });
      },
    }, u, a);
  },
});

/** Levanta en el aire: invulnerable y sin poder actuar; al caer, `onLand`. */
function lift(u: Unit, e: Unit, a: AbilityInst, d: number, onLand: (e: Unit) => void) {
  e.purge(false, true);
  if (e.cast) e.w.interruptCast(e, true);
  e.w.disjoint(e);
  return debuff(u, e, a, {
    name: 'tornado_lift', duration: d, fx: 'cyclone', purgable: false,
    states: ST.stunned | ST.invulnerable | ST.noCollision,
    onDestroy(m) { const v = m.owner as Unit; v.refreshStats(); if (v.alive) onLand(v); },
  });
}

spell({
  key: 'invoker_tornado', target: 'point', ai: { role: 'disable' }, castBeyond: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const dist = ov(a, 'travel_distance', 'w');
    const liftD = ov(a, 'lift_duration', 'q');
    const dmgv = val(a, 'base_damage') + ov(a, 'wex_damage', 'w') + ov(a, 'quas_damage', 'q');
    const interval = val(a, 'twister_distance_interval');
    let nextTwister = interval;
    u.w.addProjectile({
      kind: 'linear', fx: 'tornado', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'travel_speed'),
      left: dist, width: val(a, 'area_of_effect') * 2,
      onThink(p) {
        // Scepter: deja remolinos por el camino.
        if (interval <= 0 || p.travelled < nextTwister) return;
        nextTwister += interval;
        const x = p.x, y = p.y, r = val(a, 'twister_radius');
        const dps = ov(a, 'twister_damage', 'q'), tick = val(a, 'twister_tick_rate');
        u.w.addZone({ fx: 'twister', x, y, r, team: u.team, interval: tick, duration: ov(a, 'twister_duration', 'q'),
          onInterval() { for (const e of u.w.enemiesIn(u.team, x, y, r)) damage(u, e, dps * tick, 'magical', a, { noProc: true }); } });
      },
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.kind === 'ward' || v.has(ST.magicImmune) || v.has(ST.invulnerable)) return false;
        lift(u, v, a, liftD, (x) => damage(u, x, dmgv, 'magical', a));
        return false;
      },
      onEnd(p) { u.w.addVision(u.team, p.x, p.y, val(a, 'vision_distance'), val(a, 'end_vision_duration')); },
    });
  },
});

spell({
  key: 'invoker_emp', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'area_of_effect'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'area_of_effect');
    const delay = val(a, 'delay');
    const drag = val(a, 'drag_speed');
    u.w.emit({ n: 'emp', x: t.x, y: t.y, r, d: delay, t: u.team });
    if (drag > 0) {
      // Shard: arrastra a los enemigos hacia el centro mientras carga.
      u.w.addZone({ fx: 'emp_drag', x: t.x, y: t.y, r, team: u.team, interval: 1 / 30, duration: delay,
        onInterval() {
          for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
            const d = Math.hypot(t.x - e.x, t.y - e.y);
            if (d > 10) u.w.forceMove(e, e.x + (t.x - e.x) / d * Math.min(d, drag / 30), e.y + (t.y - e.y) / d * Math.min(d, drag / 30));
          }
        } });
    }
    u.w.after(delay, () => {
      u.w.emit({ n: 'emp_blast', x: t.x, y: t.y, r, t: u.team });
      const burn = ov(a, 'mana_burned', 'w');
      let fromHeroes = 0;
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        const b = burnMana(e, burn);
        if (e.isHero) fromHeroes += b;
        if (b > 0) damage(u, e, b * val(a, 'damage_per_mana_pct') / 100, 'magical', a);
      }
      if (fromHeroes > 0) giveMana(u, fromHeroes * val(a, 'self_mana_restore_pct') / 100);
    });
  },
});

spell({
  key: 'invoker_alacrity', target: 'unit', team: 'ally', allowSelf: true,
  onSpellStart(a, t) {
    const e = t.unit as Unit;
    e.addMod({
      name: 'alacrity', duration: val(a, 'duration'), fx: 'alacrity',
      props: { attackSpeed: ov(a, 'bonus_attack_speed', 'w'), damage: ov(a, 'bonus_damage', 'e'), attackRange: val(a, 'bonus_attack_range') },
    }, a.owner as Unit, a);
  },
});

spell({
  key: 'invoker_chaos_meteor', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'area_of_effect'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const n = Math.max(1, val(a, 'meteor_count'));
    const r = val(a, 'area_of_effect');
    const dist = ov(a, 'travel_distance', 'w');
    const main = ov(a, 'main_damage', 'e'), burn = ov(a, 'burn_dps', 'e');
    const interval = val(a, 'damage_interval');
    u.w.emit({ n: 'meteor_fall', x: t.x, y: t.y, r, d: val(a, 'land_time'), t: u.team });
    for (let i = 0; i < n; i++) {
      // Con el talento, los meteoros extra salen abiertos en abanico.
      const ang = Math.atan2(dy, dx) + (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.35);
      const mx = Math.cos(ang), my = Math.sin(ang);
      u.w.after(val(a, 'land_time'), () => {
        let acc = interval;
        u.w.addProjectile({
          kind: 'linear', fx: 'chaos_meteor', source: u, x: t.x, y: t.y, dx: mx, dy: my,
          speed: val(a, 'travel_speed'), left: dist, width: 1,
          onHit: () => false,
          onThink(p, dt) {
            acc += dt;
            if (acc < interval) return;
            acc -= interval;
            for (const e of u.w.enemiesIn(u.team, p.x, p.y, r)) {
              damage(u, e, main, 'magical', a);
              debuff(u, e, a, {
                name: 'chaos_meteor_burn', duration: val(a, 'burn_duration'), interval: 1, fx: 'burn',
                onInterval(m) { damage(u, m.owner as Unit, burn, 'magical', a, { noProc: true }); },
              });
              if (val(a, 'stun_duration') > 0) stun(u, e, val(a, 'stun_duration'), a);
            }
          },
          onEnd(p) { u.w.addVision(u.team, p.x, p.y, val(a, 'vision_distance'), val(a, 'end_vision_duration')); },
        });
      });
    }
  },
});

/** Espíritus de forja: daño y armadura por Exort; alcance, vida y duración por Quas. */
function forgeSpirits(a: AbilityInst, x: number, y: number, count: number, replace: boolean) {
  const u = a.owner as Unit;
  const w = u.w;
  if (replace) for (const s of w.list) if (s.owner === u && s.name === 'invoker_forged_spirit' && s.alive) s.expireAt = w.time;
  for (let i = 0; i < count; i++) {
    const s = w.spawnSummon(u, 'invoker_forged_spirit', x + (i - (count - 1) / 2) * 80, y, ov(a, 'spirit_duration', 'q'),
      { level: Math.max(1, orbLevel(u, 'e')), hp: ov(a, 'spirit_hp', 'q'), abilities: ['forged_spirit_melting_strike'] });
    s.base.dmgMin = s.base.dmgMax = ov(a, 'spirit_damage', 'e');
    s.base.armor = ov(a, 'spirit_armor', 'e');
    s.base.range = ov(a, 'spirit_attack_range', 'q');
    s.base.mana = ov(a, 'spirit_mana', 'e');
    s.refreshStats();
    s.hp = s.s.maxHp; s.mana = s.s.maxMana;
    s.addMod(summonFollow(s));
  }
}

spell({
  key: 'invoker_forge_spirit', target: 'none', ai: { role: 'buff', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const n = Math.min(ov(a, 'extra_spirit_count_quas', 'q'), ov(a, 'extra_spirit_count_exort', 'e'));
    forgeSpirits(a, u.x + Math.cos(u.facing) * 150, u.y + Math.sin(u.facing) * 150, Math.max(1, n), true);
  },
});

defineAbility({
  key: 'forged_spirit_melting_strike', target: 'passive',
  passive: (a) => ({
    name: 'melting_strike',
    onAttackLanded(_m, ev) {
      const t = ev.target as Unit;
      if (!t.isHeroLike || t.team === ev.attacker.team) return;
      const per = val(a, 'armor_removed'), max = val(a, 'max_armor_removed');
      const m = t.findMod('melting_strike_armor');
      const stacks = Math.min(max / per, (m?.stacks ?? 0) + 1);
      t.addMod({
        name: 'melting_strike_armor', duration: val(a, 'duration'), debuff: true, stacks, fx: 'armor_down',
        props: (mm) => ({ armor: -per * mm.stacks }),
      }, null, a);
    },
  }),
});

spell({
  key: 'invoker_ice_wall', target: 'none', ai: { role: 'aoe', selfRadius: 400 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const tgt = u.isBot ? currentTarget(u) : null;
    if (tgt) u.facing = Math.atan2(tgt.y - u.y, tgt.x - u.x);
    const fx = Math.cos(u.facing), fy = Math.sin(u.facing);
    const scepter = hasScepter(u);
    const place = scepter ? Math.min(val(a, 'vector_cast_range'), 400) : val(a, 'wall_place_distance');
    const cx = u.x + fx * place, cy = u.y + fy * place;
    const half = val(a, 'wall_total_length') / 2;
    const x1 = cx - fy * half, y1 = cy + fx * half, x2 = cx + fy * half, y2 = cy - fx * half;
    const width = val(a, 'wall_width');
    const tick = val(a, 'tick_interval');
    const dps = ov(a, 'damage_per_second', 'e');
    const slowPct = Math.abs(ov(a, 'slow', 'q')) / 100;
    const inside = new Map<number, number>();
    const rooted = new Set<number>();
    const start = () => {
      u.w.emit({ n: 'ice_wall', x: x1, y: y1, x2, y2, r: width, d: ov(a, 'duration', 'q'), t: u.team });
      u.w.addZone({ fx: 'ice_wall', x: cx, y: cy, r: half, team: u.team, interval: tick, duration: ov(a, 'duration', 'q'),
        onInterval() {
          for (const e of u.w.enemiesIn(u.team, cx, cy, half + 50)) {
            if (distToSegment(e.x, e.y, x1, y1, x2, y2) > width / 2 + e.radius + 60) { inside.delete(e.id); continue; }
            slow(u, e, a, 'ice_wall_slow', val(a, 'slow_duration'), slowPct);
            damage(u, e, dps * tick, 'magical', a, { noProc: true });
            // Scepter (Ice Floe): los héroes que se quedan dentro acaban enraizados.
            if (scepter && e.isHero && !rooted.has(e.id)) {
              const tIn = (inside.get(e.id) ?? 0) + tick;
              inside.set(e.id, tIn);
              if (tIn >= val(a, 'root_delay')) {
                rooted.add(e.id);
                debuff(u, e, a, { name: 'ice_floe_root', duration: val(a, 'root_duration'), states: ST.rooted, fx: 'root' });
                damage(u, e, ov(a, 'root_damage', 'q'), 'magical', a);
              }
            }
          }
        } });
    };
    if (scepter) u.w.after(val(a, 'glacier_formation_delay'), start); else start();
  },
});

spell({
  key: 'invoker_sun_strike', target: 'point', ai: { role: 'nuke' }, castBeyond: true,
  castRange: () => 99999,
  aoe: (a) => val(a, 'area_of_effect'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    // Scepter: lanzado sobre uno mismo es Cataclysm (dos rayos junto a cada héroe enemigo visible).
    if (hasScepter(u) && Math.hypot(t.x - u.x, t.y - u.y) < 150 && val(a, 'cataclysm_count') > 0) {
      a.cd = val(a, 'cataclysm_cooldown') * (1 - u.s.cdr);
      for (const e of u.w.list) {
        if (e.kind !== 'hero' || e.team === u.team || !e.alive || !u.w.canSee(u.team, e)) continue;
        for (let i = 0; i < val(a, 'cataclysm_count'); i++) {
          const ang = u.w.rng() * Math.PI * 2;
          const d = val(a, 'cataclysm_min_range') + u.w.rng() * (val(a, 'cataclysm_max_range') - val(a, 'cataclysm_min_range'));
          sunStrike(a, e.x + Math.cos(ang) * d, e.y + Math.sin(ang) * d, val(a, 'cataclysm_damage_pct') / 100);
        }
      }
      return;
    }
    sunStrike(a, t.x, t.y, 1);
  },
});

function sunStrike(a: AbilityInst, x: number, y: number, mult: number) {
  const u = a.owner as Unit;
  const r = val(a, 'area_of_effect');
  const total = ov(a, 'damage', 'e') * mult;
  u.w.emit({ n: 'sun_strike_warn', x, y, r, d: val(a, 'delay'), t: u.team });
  u.w.addVision(u.team, x, y, val(a, 'vision_distance'), val(a, 'vision_duration'));
  u.w.after(val(a, 'delay'), () => {
    u.w.emit({ n: 'sun_strike', x, y, r, t: u.team });
    const hit = u.w.enemiesIn(u.team, x, y, r, { immune: true }).filter((e) => e.kind !== 'ward');
    let heroHit = false;
    for (const e of hit) {
      if (damage(u, e, total / hit.length, 'pure', a) > 0 && e.isHero) heroHit = true;
    }
    // Shard: crea un espíritu de forja donde da a un héroe.
    if (heroHit && val(a, 'create_forged_spirit_on_hero_damage') > 0) {
      const store = (invokeOf(u)?.data.store ?? {}) as Record<string, AbilityInst>;
      const fs = store.invoker_forge_spirit ?? [u.abilities[3], u.abilities[4]].find((s) => s.key === 'invoker_forge_spirit') ?? makeAbility(u, 'invoker_forge_spirit', 3);
      if (fs) { fs.level = 1; forgeSpirits(fs, x, y, 1, false); }
    }
  });
}

spell({
  key: 'invoker_deafening_blast', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const n = Math.max(1, val(a, 'radial_count'));
    const kb = ov(a, 'knockback_duration', 'q'), dis = ov(a, 'disarm_duration', 'w');
    const d = ov(a, 'damage', 'e');
    const hit = new Set<number>();
    for (let i = 0; i < n; i++) {
      const ang = Math.atan2(dy, dx) + i * Math.PI * 2 / n;
      const bx = Math.cos(ang), by = Math.sin(ang);
      u.w.addProjectile({
        kind: 'linear', fx: 'deafening_blast', source: u, x: u.x, y: u.y, dx: bx, dy: by,
        speed: val(a, 'travel_speed'), left: val(a, 'travel_distance'),
        width: val(a, 'radius_start') * 2, widthEnd: val(a, 'radius_end') * 2,
        onHit(_p, e) {
          const v = e as Unit;
          if (v.team === u.team || v.kind === 'ward' || v.has(ST.magicImmune) || hit.has(v.id)) return false;
          hit.add(v.id);
          damage(u, v, d, 'magical', a);
          if (!v.alive) return false;
          // Empuje corto y luego desarme.
          push(v, bx, by, kb * 100, kb, u, a, 'deafening_blast_knockback');
          debuff(u, v, a, { name: 'deafening_blast_disarm', duration: dis, states: ST.disarmed, fx: 'disarm' });
          return false;
        },
        onEnd(p) { u.w.addVision(u.team, p.x, p.y, 300, val(a, 'end_vision_duration')); },
      });
    }
  },
});

defineHero('invoker', ['invoker_quas', 'invoker_wex', 'invoker_exort', 'invoker_empty1', 'invoker_empty2', 'invoker_invoke'], {
  build: ['null_talisman', 'power_treads', 'hand_of_midas', 'blink', 'black_king_bar', 'ultimate_scepter', 'sheepstick', 'refresher'],
  upgrades: [
    { slot: 0, key: 'hp_regen_per_instance', amount: 1.5, max: 5, label: 'Quas: +1.5 regeneración por instancia' },
    { slot: 1, key: 'attack_speed_per_instance', amount: 4, max: 5, label: 'Wex: +4 velocidad de ataque por instancia' },
    { slot: 2, key: 'bonus_damage_per_instance', amount: 4, max: 5, label: 'Exort: +4 daño por instancia' },
    { slot: 5, key: '_cd', amount: -10, pct: true, max: 5, label: 'Invoke: −10% enfriamiento' },
  ],
});
