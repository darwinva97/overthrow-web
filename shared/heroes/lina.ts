import { defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abilityOf } from './lib/a0';
import { castDir, debuff, stun } from './util';

const BURN_TICK = 0.5;

/**
 * Daño de hechizo de Lina: impacto + quemadura de Slow Burn (innata) y una carga de Fiery Soul
 * la primera vez que el lanzamiento alcanza a un enemigo.
 */
function linaHit(a: AbilityInst, e: Unit, amount: number) {
  const u = a.owner as Unit;
  const sb = abilityOf(u, 'lina_slow_burn');
  const impact = sb ? amount * val(sb, 'impact_damage_pct') / 100 : amount;
  damage(u, e, impact, 'magical', a);
  if (a.data.hitToken !== a.data.castToken) {
    a.data.hitToken = a.data.castToken;
    if (e.team !== u.team) addFierySoul(u, 1);
  }
  if (!sb || !e.alive || a.temp) return;
  const total = amount * val(sb, 'burn_damage_pct') / 100;
  const d = val(sb, 'burn_duration');
  if (total <= 0 || d <= 0) return;
  const old = e.findMod('slow_burn', u);
  const pool = (old?.data.pool ?? 0) + total;
  const m = debuff(u, e, sb, {
    name: 'slow_burn', duration: d, interval: BURN_TICK, fx: 'fiery_soul', data: { pool },
    onInterval(mm) {
      const ticks = Math.max(1, Math.round(mm.remaining / BURN_TICK) + 1);
      const amt = mm.data.pool / ticks;
      mm.data.pool -= amt;
      // Sin habilidad asociada para no llenar la pantalla de números: la amplificación se aplica aquí.
      damage(u, mm.owner as Unit, amt * (1 + u.s.spellAmp), 'magical', null, { noProc: true });
    },
  });
  if (m) { m.data.pool = pool; m.remaining = m.duration = d; }
}

/** Suma cargas de Fiery Soul (hasta el máximo). */
function addFierySoul(u: Unit, n: number) {
  const fs = abilityOf(u, 'lina_fiery_soul');
  if (!fs || fs.level <= 0) return;
  const max = val(fs, 'fiery_soul_max_stacks');
  const cur = u.findMod('fiery_soul', u);
  const stacks = Math.min(max, (cur?.stacks ?? 0) + n);
  const b = u.addMod({
    name: 'fiery_soul', duration: val(fs, 'fiery_soul_stack_duration'), stacks, fx: 'fiery_soul',
    props: (mm) => fierySoulProps(fs, mm.stacks),
  }, u, fs);
  b.remaining = b.duration = val(fs, 'fiery_soul_stack_duration');
  b.stacks = stacks;
  u.refreshStats();
}

const fierySoulProps = (fs: AbilityInst, n: number) => ({
  attackSpeed: n * val(fs, 'fiery_soul_attack_speed_bonus'),
  msPct: n * val(fs, 'fiery_soul_move_speed_bonus') / 100,
  // Talento: resistencia mágica por carga.
  magicResist: Math.min(0.9, n * val(fs, 'fiery_soul_magic_resist') / 100),
});

const newCast = (a: AbilityInst) => { a.data.castToken = (a.data.castToken ?? 0) + 1; };

defineAbility({
  key: 'lina_dragon_slave', target: 'unitOrPoint', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    newCast(a);
    const [dx, dy] = castDir(u, t.x, t.y);
    u.w.addProjectile({
      kind: 'linear', fx: 'dragon_slave', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'dragon_slave_speed'),
      left: val(a, 'dragon_slave_distance') + u.s.castRange,
      width: val(a, 'dragon_slave_width_initial'), widthEnd: val(a, 'dragon_slave_width_end'),
      onHit(_p, e) {
        if (e.team !== u.team) linaHit(a, e as Unit, dmg(a, 'dragon_slave_damage'));
      },
    });
  },
});

defineAbility({
  key: 'lina_light_strike_array', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'light_strike_array_aoe'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    newCast(a);
    const r = val(a, 'light_strike_array_aoe');
    const delay = val(a, 'light_strike_array_delay_time');
    u.w.emit({ n: 'lsa_warn', x: t.x, y: t.y, r, d: delay, t: u.team });
    u.w.addVision(u.team, t.x, t.y, r, delay + 1);
    u.w.after(delay, () => {
      u.w.emit({ n: 'lsa', x: t.x, y: t.y, r, t: u.team });
      u.w.cutTrees(t.x, t.y, r);
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        linaHit(a, e, dmg(a, 'light_strike_array_damage'));
        stun(u, e, dur(a, 'light_strike_array_stun_duration'), a);
      }
    });
  },
});

defineAbility({
  key: 'lina_fiery_soul', target: 'passive',
});

// Aghanim's Scepter: movimiento sin obstáculos, amplificación y resistencia mágica, Fiery Soul al máximo.
defineAbility({
  key: 'lina_flame_cloak', target: 'none', ai: { role: 'buff', selfRadius: 800 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'flame_cloak', duration: val(a, 'flame_cloak_duration'), fx: 'fiery_soul',
      states: ST.flying | ST.noCollision,
      props: { magicResist: val(a, 'magic_resistance') / 100, spellAmp: val(a, 'spell_amp') / 100 },
      onDestroy(m) {
        const o = m.owner as Unit;
        // Al aterrizar no puede quedarse dentro de un árbol.
        if (!o.w.grid.walkable(o.x, o.y)) o.w.teleport(o, o.x, o.y);
      },
    }, u, a);
    addFierySoul(u, 99);
  },
});

defineAbility({
  key: 'lina_slow_burn', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'slow_burn_crit',
    // Talento: crítico contra objetivos que se están quemando.
    onAttackStart(_m, ev) {
      const mult = val(a, 'target_crit_multiplier');
      if (mult > 0 && (ev.target as Unit).findMod('slow_burn', ev.attacker)) ev.critMult = Math.max(ev.critMult, mult / 100);
    },
  }),
});

defineAbility({
  key: 'lina_laguna_blade', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke', hpBelow: 0.6 },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    newCast(a);
    const e = t.unit as Unit;
    u.w.emit({ n: 'laguna', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
    u.w.after(val(a, 'damage_delay'), () => {
      if (e.alive && (!e.has(ST.magicImmune) || val(a, 'pierce_immunity') > 0)) linaHit(a, e, dmg(a, 'damage'));
    });
    // Shard: sobrecarga de Fiery Soul por encima del máximo.
    if (hasShard(u) && !a.temp) {
      const fs = abilityOf(u, 'lina_fiery_soul');
      const n = val(a, 'supercharge_stacks');
      if (fs && fs.level > 0 && n > 0) {
        u.addMod({
          name: 'fiery_soul_supercharge', duration: val(a, 'supercharge_duration'), stacks: n, fx: 'fiery_soul',
          props: (m) => fierySoulProps(fs, m.stacks),
        }, u, a);
      }
    }
  },
});

defineHero('lina', ['lina_dragon_slave', 'lina_light_strike_array', 'lina_fiery_soul', 'lina_flame_cloak', 'lina_slow_burn', 'lina_laguna_blade'], {
  build: ['null_talisman', 'phase_boots', 'kaya', 'cyclone', 'black_king_bar', 'sheepstick', 'greater_crit'],
});
