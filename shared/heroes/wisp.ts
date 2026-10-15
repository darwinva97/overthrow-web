import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst, Modifier } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botAllyTarget, dist } from './lib/a9';
import { canDebuff, dash, slow } from './util';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
/** Aliado unido por Tether, si lo hay. */
function tethered(u: Unit): Unit | null {
  const m = u.findMod('tether', u);
  const t = m ? u.w.units.get(m.data.ally) : undefined;
  return t && t.alive ? t : null;
}

/** Distancia de un punto a un segmento. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy || 1;
  const k = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - (ax + vx * k), py - (ay + vy * k));
}

defineAbility({
  key: 'wisp_tether', target: 'unit', team: 'ally', noIllusion: true, ai: { role: 'buff' },
  // Bots: se unen al aliado más cercano (héroes primero).
  passive: (a) => botAllyTarget(a, (u) => u.w.alliesIn(u.team, u.x, u.y, val(a, 'abilitycastrange'))
    .filter((x) => x !== u && x.kind !== 'ward' && !x.name.startsWith('wisp'))
    .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || dist(p, u) - dist(q, u))[0] ?? null),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (e === u) return;
    u.removeModsByName('tether');
    const w = u.w;
    const ms = val(a, 'movespeed') / 100;
    const allyMod = e.addMod({
      name: 'tether_ally', duration: Infinity, fx: 'tether',
      props: { msPct: ms },
      // Talento: Io golpea también al objetivo de su aliado.
      onAttackLanded(_m, ev) {
        const p = val(a, 'tether_attack_damage_pct');
        const tg = ev.target as Unit;
        if (p > 0 && u.alive && tg.team !== u.team) damage(u, tg, ev.damage * p / 100, 'physical', a, { noProc: true });
      },
    }, u, a);
    if (dist(u, e) > val(a, 'latch_distance')) {
      const d = dist(u, e);
      const k = (d - val(a, 'latch_distance')) / d;
      dash(u, u.x + (e.x - u.x) * k, u.y + (e.y - u.y) * k, val(a, 'latch_speed'), a, { name: 'tether_latch' });
    }
    let acc = 0;
    u.addMod({
      name: 'tether', duration: Infinity, fx: 'tether', data: { ally: e.id, hp: u.hp, mana: u.mana },
      props: { msPct: ms },
      onTick(m: Modifier, dt: number) {
        if (!e.alive || !u.alive || dist(u, e) > val(a, 'radius') + 200) { u.removeMod(m); return; }
        // Lo que Io recupera, el aliado lo recibe amplificado.
        const dh = u.hp - m.data.hp, dm = u.mana - m.data.mana;
        if (dh > 0) heal(e, dh * val(a, 'tether_heal_amp') / 100, u, true);
        if (dm > 0) e.mana = Math.min(e.s.maxMana, e.mana + dm * val(a, 'tether_mana_amp') / 100);
        m.data.hp = u.hp; m.data.mana = u.mana;
        acc += dt;
        const tick = val(a, 'tick_rate');
        if (acc < tick) return;
        acc -= tick;
        const cx = (u.x + e.x) / 2, cy = (u.y + e.y) / 2;
        for (const v of w.enemiesIn(u.team, cx, cy, dist(u, e) / 2 + 100)) {
          if (segDist(v.x, v.y, u.x, u.y, e.x, e.y) > v.radius + 20) continue;
          slow(u, v, a, 'tether_slow', val(a, 'slow_duration') + tick, val(a, 'slow') / 100);
          // Shard: daña y cura a Io.
          if (val(a, 'damage') > 0 && canDebuff(u, v, a)) {
            const dealt = damage(u, v, dmg(a, 'damage') * tick, 'magical', a, { noProc: true });
            heal(u, dealt * val(a, 'damage_to_heal') / 100, u, true);
            m.data.hp = u.hp;
          }
        }
      },
      onDestroy() { e.removeMod(allyMod); },
    }, u, a);
    w.emit({ n: 'tether', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
  },
});

defineAbility({
  key: 'wisp_tether_break', target: 'toggle', levelWith: 0,
  hidden: (a) => !tethered(a.owner as Unit),
  onToggle(a) { (a.owner as Unit).removeModsByName('tether'); a.toggled = false; },
});

interface Spirit { ang: number; hits: Map<number, number> }
/** Posición del espíritu i: repartidos por el círculo y girando. */
function spiritPos(u: Unit, d: Record<string, any>, i: number): [number, number] {
  const list = d.list as Spirit[];
  const ang = list[i].ang + (i / Math.max(1, list.length)) * Math.PI * 2;
  return [u.x + Math.cos(ang) * d.radius, u.y + Math.sin(ang) * d.radius];
}

/** Explota un espíritu en (x, y). */
function burst(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const r = val(a, 'explode_radius');
  u.w.emit({ n: 'wisp_spirit_explode', x, y, r, t: u.team });
  for (const e of u.w.enemiesIn(u.team, x, y, r)) {
    damage(u, e, e.isHeroLike ? dmg(a, 'hero_damage') : dmg(a, 'creep_damage'), 'magical', a);
  }
}

defineAbility({
  key: 'wisp_spirits', target: 'none', noIllusion: true, ai: { role: 'aoe', selfRadius: 600 },
  // Controlador de los espíritus: giran alrededor de Io y explotan al tocar héroes enemigos.
  passive: (a) => ({
    name: 'wisp_spirits', data: { list: [] as Spirit[], radius: val(a, 'default_radius'), until: 0, toSpawn: 0, spawnAcc: 0 },
    onTick(m, dt) {
      const u = m.owner as Unit;
      const w = u.w;
      const d = m.data;
      const list = d.list as Spirit[];
      const scepter = hasScepter(u);
      if (!u.alive) { d.list = []; return; }
      d.spawnAcc += dt;
      const max = val(a, 'spirit_amount');
      const spawning = scepter ? list.length < max : d.toSpawn > 0 && d.until > w.time;
      if (spawning && d.spawnAcc >= val(a, 'spirit_spawn_time')) {
        d.spawnAcc = 0;
        if (!scepter) d.toSpawn--;
        list.push({ ang: u.facing, hits: new Map() });
      }
      if (!spawning) d.spawnAcc = Math.min(d.spawnAcc, val(a, 'spirit_spawn_time'));
      if (!scepter && list.length && d.until <= w.time) {
        list.forEach((_s, i) => burst(a, ...spiritPos(u, d, i)));
        d.list = [];
        return;
      }
      if (!list.length) return;
      const inn = ab(u, 'wisp_spirits_in')?.toggled, out = ab(u, 'wisp_spirits_out')?.toggled;
      const rate = val(a, 'spirit_movement_rate') * dt;
      if (inn) d.radius = Math.max(val(a, 'min_range'), d.radius - rate);
      if (out) d.radius = Math.min(val(a, 'max_range'), d.radius + rate);
      const spin = Math.PI * 2 / val(a, 'revolution_time') * dt;
      const keep: Spirit[] = [];
      list.forEach((s, i) => {
        s.ang += spin;
        const [x, y] = spiritPos(u, d, i);
        if (w.tickN % 3 === 0) w.emit({ n: 'wisp_spirit', x, y, u: u.id, d: 0.12 });
        const hero = w.enemiesIn(u.team, x, y, val(a, 'hero_hit_radius'), { heroes: true })[0];
        if (hero) {
          burst(a, x, y);
          if (val(a, 'scepter_slow_pct') > 0) slow(u, hero, a, 'wisp_spirit_slow', val(a, 'scepter_slow_duration'), val(a, 'scepter_slow_pct') / 100);
          return;
        }
        for (const c of w.enemiesIn(u.team, x, y, val(a, 'hit_radius'))) {
          if (c.isHeroLike || (s.hits.get(c.id) ?? -9) > w.time - 1) continue;
          s.hits.set(c.id, w.time);
          damage(u, c, dmg(a, 'creep_damage'), 'magical', a);
        }
        keep.push(s);
      });
      d.list = keep;
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const m = a.passiveMod;
    if (!m) return;
    const d = m.data;
    // Con Scepter, lanzarla hace explotar los espíritus.
    if (hasScepter(u)) (d.list as Spirit[]).forEach((_s, i) => burst(a, ...spiritPos(u, d, i)));
    if (hasScepter(u)) { d.list = []; return; }
    d.list = []; d.toSpawn = val(a, 'spirit_amount'); d.until = u.w.time + dur(a, 'spirit_duration');
    d.spawnAcc = val(a, 'spirit_spawn_time'); d.radius = val(a, 'default_radius');
  },
});

const spiritsActive = (a: AbilityInst) => !!((ab(a.owner as Unit, 'wisp_spirits')?.passiveMod?.data.list as Spirit[] | undefined)?.length);

defineAbility({
  key: 'wisp_spirits_in', target: 'toggle', levelWith: 1, hidden: (a) => !spiritsActive(a),
  onToggle(a, on) { const o = ab(a.owner as Unit, 'wisp_spirits_out'); if (on && o) o.toggled = false; },
});
defineAbility({
  key: 'wisp_spirits_out', target: 'toggle', levelWith: 1, hidden: (a) => !spiritsActive(a),
  onToggle(a, on) { const o = ab(a.owner as Unit, 'wisp_spirits_in'); if (on && o) o.toggled = false; },
});

defineAbility({
  key: 'wisp_overcharge', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const spec = {
      name: 'overcharge', duration: dur(a, 'duration'), fx: 'overcharge',
      props: {
        attackSpeed: val(a, 'bonus_attack_speed'), spellAmp: val(a, 'bonus_spell_amp') / 100,
        hpRegenPct: val(a, 'hp_regen') / 100, armor: val(a, 'bonus_armor'), magicResist: val(a, 'bonus_mres') / 100,
        slowResist: val(a, 'unslowable') > 0 ? 1 : 0,
      },
    };
    u.addMod(spec, u, a);
    const t = tethered(u);
    if (t) t.addMod(spec, u, a);
  },
});

defineAbility({
  key: 'wisp_relocate', target: 'point', ult: true, castBeyond: true, ai: { role: 'escape' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const delay = val(a, 'cast_delay');
    w.emit({ n: 'relocate_warn', x: t.x, y: t.y, d: delay, u: u.id, t: u.team });
    u.addMod({ name: 'relocate_channel', duration: delay, fx: 'relocate' }, u, a);
    w.after(delay, () => {
      if (!u.alive) return;
      const ally = tethered(u);
      const group = [u, ...(ally ? [ally] : [])];
      const homes = group.map((g) => ({ g, x: g.x, y: g.y }));
      for (const g of group) {
        w.disjoint(g);
        w.teleport(g, t.x + (g === u ? 0 : 80), t.y);
        w.emit({ n: 'blink', x: g.x, y: g.y, u: g.id, c: 'wisp' });
      }
      // Pasado el tiempo, vuelven a donde estaban.
      u.addMod({
        name: 'relocate', duration: val(a, 'return_time'), fx: 'relocate', purgable: false,
        onDestroy() {
          for (const h of homes) if (h.g.alive) { w.disjoint(h.g); w.teleport(h.g, h.x, h.y); }
        },
      }, u, a);
    });
  },
});

defineAbility({
  key: 'wisp_equilibrium', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'equilibrium', interval: 0.25,
    props: (m) => {
      const u = m.owner as Unit;
      const k = u.hp / Math.max(1, u.s.maxHp);
      // hpRegenAmp amplifica regeneración y curaciones.
      return { outgoingPct: val(a, 'damage_amplification') / 100 * k, hpRegenAmp: val(a, 'heal_amplification') / 100 * (1 - k) };
    },
    onInterval(m) { (m.owner as Unit).refreshStats(); },
  }),
});

defineHero('wisp', ['wisp_tether', 'wisp_spirits', 'wisp_overcharge', 'wisp_spirits_in', 'wisp_spirits_out', 'wisp_relocate', 'wisp_tether_break', 'wisp_equilibrium'], {
  build: ['bracer', 'arcane_boots', 'holy_locket', 'glimmer_cape', 'guardian_greaves', 'ultimate_scepter', 'heart'],
});
