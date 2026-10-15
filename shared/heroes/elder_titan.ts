import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasTalent, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, slow } from './util';
import { botCast, distToSegment, foes, nearestEnemyHero } from './lib/a3';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key && x.level > 0);
/** Espíritu astral vivo del Titán (o null). */
function spiritOf(u: Unit): Unit | null {
  const a = u.abilities.find((x) => x.key === 'elder_titan_ancestral_spirit');
  const s = a?.data.spirit ? u.w.units.get(a.data.spirit) : null;
  return s && s.alive ? s : null;
}

/** Pisotones del Titán (físico) y del espíritu (mágico): primero el daño, luego el sueño. */
function stomps(u: Unit, a: AbilityInst, spots: { x: number; y: number; type: 'physical' | 'magical' }[]) {
  const r = val(a, 'radius');
  const slept = new Set<Unit>();
  for (const p of spots) {
    u.w.emit({ n: 'echo_stomp', x: p.x, y: p.y, r, t: u.team });
    for (const e of foes(u, p.x, p.y, r, a)) {
      damage(u, e, dmg(a, 'stomp_damage'), p.type, a);
      if (e.alive) slept.add(e);
    }
  }
  for (const e of slept) {
    if (!e.alive) continue;
    debuff(u, e, a, {
      name: 'echo_stomp_sleep', duration: dur(a, 'sleep_duration'), states: ST.stunned, fx: 'sleep',
      data: { taken: 0 },
      onCreated(m) { const v = m.owner as Unit; v.atk.phase = 0; if (v.cast) v.w.interruptCast(v, true); },
      onTakeDamage(m, ev) {
        m.data.taken += ev.amount;
        if (m.data.taken >= val(a, 'wake_damage_limit')) m.remaining = 0.001;
      },
    });
  }
}

defineAbility({
  key: 'elder_titan_echo_stomp', target: 'none', ai: { role: 'disable', selfRadius: 380 },
  aoe: (a) => val(a, 'radius'),
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.w.emit({ n: 'echo_stomp_warn', x: u.x, y: u.y, r: val(a, 'radius'), d: val(a, 'abilitychanneltime'), t: u.team });
  },
  onChannelEnd(a, interrupted) {
    if (interrupted) return;
    const u = a.owner as Unit;
    const s = spiritOf(u);
    stomps(u, a, [{ x: u.x, y: u.y, type: 'physical' }, ...(s ? [{ x: s.x, y: s.y, type: 'magical' as const }] : [])]);
  },
});

/** Bonus al volver el espíritu, según lo que atravesó. */
function spiritReturn(u: Unit, a: AbilityInst, heroes: number, creeps: number) {
  const pct = Math.min(val(a, 'move_pct_cap'), heroes * val(a, 'move_pct_heroes') + creeps * val(a, 'move_pct_creeps'));
  const bonusDmg = heroes * dmg(a, 'damage_heroes') + creeps * dmg(a, 'damage_creeps');
  const armor = heroes * val(a, 'armor_heroes') + creeps * val(a, 'armor_creeps');
  if (heroes + creeps > 0) {
    u.addMod({
      name: 'astral_spirit_buff', duration: dur(a, 'buff_duration'), fx: 'astral_buff',
      props: { damage: bonusDmg, msPct: pct / 100, armor },
    }, u, a);
  }
  // Scepter: inmune a debuffs y resistencia mágica por cada héroe atravesado.
  if (hasScepter(u) && heroes > 0) {
    u.purge(true, false);
    u.addMod({
      name: 'astral_spirit_immunity', duration: heroes * val(a, 'scepter_magic_immune_per_hero'), fx: 'bkb',
      states: ST.magicImmune, props: { magicResist: val(a, 'immunity_resist') / 100 },
    }, u, a);
  }
}

defineAbility({
  key: 'elder_titan_ancestral_spirit', target: 'point', castBeyond: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const old = spiritOf(u);
    if (old) { old.alive = false; u.w.removeLater(old, 0.1); }
    const life = val(a, 'spirit_duration');
    // El destino se recorta al alcance.
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const range = castRangeOf(a);
    const k = d > range ? range / d : 1;
    const tx = u.x + (t.x - u.x) * k, ty = u.y + (t.y - u.y) * k;
    const s = u.w.spawnSummon(u, 'elder_titan_ancestral_spirit', u.x, u.y, life + 30, { abilities: [] });
    a.data.spirit = s.id;
    const no = ab(u, 'elder_titan_natural_order');
    s.addMod({
      name: 'astral_spirit', persistent: true, fx: 'astral_spirit',
      states: ST.invulnerable | ST.untargetable | ST.noCollision | ST.busy | ST.flying | ST.disarmed,
      data: { dest: { x: tx, y: ty }, returning: false, born: u.w.time, hit: new Set<number>(), heroes: 0, creeps: 0 },
      // Natural Order: la reducción de resistencia mágica va con el espíritu.
      aura: no ? {
        radius: val(no, 'radius'), team: 'enemy',
        apply: () => naturalOrderSpec(no, false, true),
      } : undefined,
      onTick(m, dt) {
        const w = s.w;
        if (!u.alive) { s.alive = false; w.removeLater(s, 0.1); return; }
        if (!m.data.returning && w.time - m.data.born >= life) m.data.returning = true;
        const dest = m.data.returning ? { x: u.x, y: u.y } : m.data.dest;
        const d = Math.hypot(dest.x - s.x, dest.y - s.y);
        const step = val(a, 'speed') * dt;
        if (d <= step) {
          s.x = dest.x; s.y = dest.y;
          if (m.data.returning) {
            spiritReturn(u, a, m.data.heroes, m.data.creeps);
            s.alive = false;
            a.data.spirit = 0;
            w.removeLater(s, 0.1);
            return;
          }
        } else {
          s.x += (dest.x - s.x) / d * step;
          s.y += (dest.y - s.y) / d * step;
          s.facing = Math.atan2(dest.y - s.y, dest.x - s.x);
        }
        // Daña una vez a cada unidad que atraviesa.
        for (const e of foes(u, s.x, s.y, val(a, 'radius'), a)) {
          if (m.data.hit.has(e.id) || e.kind === 'ward') continue;
          m.data.hit.add(e.id);
          if (e.kind === 'hero') m.data.heroes++;
          else m.data.creeps++;
          damage(u, e, dmg(a, 'pass_damage'), 'magical', a);
        }
      },
    }, u, a);
    u.w.emit({ n: 'astral_spirit', x: u.x, y: u.y, x2: tx, y2: ty, u: s.id, t: u.team });
  },
});

/** Reducción de armadura base y/o resistencia mágica base. */
function naturalOrderSpec(a: AbilityInst, armor: boolean, mr: boolean): ModSpec {
  return {
    name: armor ? 'natural_order' : 'natural_order_spirit', debuff: true, purgable: false,
    props: (m) => {
      const t = m.owner as Unit;
      const out: Record<string, number> = {};
      if (armor) {
        const base = t.base.armor + (t.hero ? t.baseAttr('agi') / 6 : 0);
        if (base > 0) out.armor = -base * val(a, 'armor_reduction_pct') / 100;
      }
      if (mr) {
        const b = Math.min(0.95, t.base.mr / 100);
        const p = val(a, 'magic_resistance_pct') / 100;
        if (b > 0) out.magicResist = 1 - (1 - b * (1 - p)) / (1 - b);
      }
      return out;
    },
  };
}

defineAbility({
  key: 'elder_titan_natural_order', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'natural_order_aura',
    aura: {
      radius: val(a, 'radius'), team: 'enemy',
      apply: (m) => naturalOrderSpec(a, true, !spiritOf(m.owner as Unit)),
    },
  }),
});

defineAbility({
  key: 'elder_titan_move_spirit', target: 'point', castBeyond: true, levelWith: 1,
  castRange: () => 0,
  hidden: (a) => !spiritOf(a.owner as Unit),
  // Bot: lleva el espíritu encima del héroe enemigo más cercano.
  passive: (a) => botCast(a, (u) => {
    const s = spiritOf(u);
    const m = s?.findMod('astral_spirit');
    if (!s || !m || m.data.returning) return null;
    const e = nearestEnemyHero(u, 1400);
    if (!e || m.data.hit.has(e.id)) return null;
    if (Math.hypot(m.data.dest.x - e.x, m.data.dest.y - e.y) < 150) return null;
    return { x: e.x, y: e.y };
  }, 0.5),
  onSpellStart(a, t) {
    const s = spiritOf(a.owner as Unit);
    const m = s?.findMod('astral_spirit');
    if (m && !m.data.returning) m.data.dest = { x: t.x, y: t.y };
  },
});

// Innata: armadura según la velocidad de movimiento extra (y velocidad de ataque con talento).
defineAbility({
  key: 'elder_titan_momentum', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'momentum', interval: 0.5,
    props: (m) => {
      const u = m.owner as Unit;
      const bonus = Math.max(0, u.s.ms - u.base.ms);
      const as = hasTalent(u, 'special_bonus_unique_elder_titan_momentum_attack_speed') ? val(a, 'attack_speed_from_movespeed') : 0;
      return { armor: bonus * val(a, 'armor_from_movespeed') / 100, attackSpeed: bonus * as / 100 };
    },
    onInterval(m) { (m.owner as Unit).refreshStats(); },
  }),
});

defineAbility({
  key: 'elder_titan_earth_splitter', target: 'point', ult: true, castBeyond: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = val(a, 'crack_distance');
    const x0 = u.x, y0 = u.y, x1 = u.x + dx * len, y1 = u.y + dy * len;
    const width = val(a, 'crack_width');
    const delay = val(a, 'crack_time');
    u.w.emit({ n: 'earth_splitter', x: x0, y: y0, x2: x1, y2: y1, r: width / 2, d: delay, t: u.team });
    for (let i = 0; i <= val(a, 'total_steps'); i++) {
      const k = (i * val(a, 'vision_step')) / len;
      if (k > 1) break;
      u.w.addVision(u.team, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, val(a, 'vision_width') / 2, val(a, 'vision_duration'));
    }
    u.w.after(delay, () => {
      u.w.emit({ n: 'earth_splitter_hit', x: x0, y: y0, x2: x1, y2: y1, r: width / 2, t: u.team });
      for (const e of foes(u, (x0 + x1) / 2, (y0 + y1) / 2, len / 2 + width, a)) {
        if (distToSegment(e.x, e.y, x0, y0, x1, y1) > width / 2 + e.radius) continue;
        const total = e.s.maxHp * val(a, 'damage_pct') / 100 * a.upg.dmg;
        damage(u, e, total / 2, 'magical', a);
        damage(u, e, total / 2, 'physical', a);
        slow(u, e, a, 'earth_splitter', dur(a, 'slow_duration'), val(a, 'slow_pct') / 100);
      }
    });
  },
});

defineAbility({
  key: 'elder_titan_return_spirit', target: 'none', levelWith: 1,
  hidden: (a) => !spiritOf(a.owner as Unit),
  // Bot: lo recoge cuando ya ha atravesado algún héroe.
  passive: (a) => botCast(a, (u) => {
    const m = spiritOf(u)?.findMod('astral_spirit');
    if (!m || m.data.returning) return null;
    return m.data.heroes > 0 && u.w.time - m.data.born > 2.5 ? u : null;
  }, 0.5),
  onSpellStart(a) {
    const m = spiritOf(a.owner as Unit)?.findMod('astral_spirit');
    if (m) m.data.returning = true;
  },
});

defineHero('elder_titan', ['elder_titan_echo_stomp', 'elder_titan_ancestral_spirit', 'elder_titan_natural_order', 'elder_titan_move_spirit', 'elder_titan_momentum', 'elder_titan_earth_splitter', 'elder_titan_return_spirit'], {
  build: ['magic_wand', 'phase_boots', 'blink', 'pipe', 'black_king_bar', 'ultimate_scepter', 'assault', 'shivas_guard'],
  upgrades: [
    { slot: 0, key: 'stomp_damage', amount: 25, max: 5, label: 'Echo Stomp: +25 daño' },
    { slot: 0, key: 'sleep_duration', amount: 0.3, max: 4, label: 'Echo Stomp: +0,3 s de sueño' },
    { slot: 1, key: 'damage_heroes', amount: 12, max: 5, label: 'Astral Spirit: +12 daño por héroe' },
    { slot: 1, key: 'pass_damage', amount: 30, max: 5, label: 'Astral Spirit: +30 daño al atravesar' },
    { slot: 2, key: 'radius', amount: 40, max: 4, label: 'Natural Order: +40 de radio' },
    { slot: 5, key: 'damage_pct', amount: 3, max: 5, label: 'Earth Splitter: +3% de vida máxima' },
    { slot: 5, key: '_cd', amount: -8, max: 4, label: 'Earth Splitter: −8 s de enfriamiento' },
  ],
});
