import { defineAbility, defineHero, dmg, dur, manaCostOf, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst, Modifier } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { canDebuff, dash, debuff } from './util';

const skin = (u: Unit) => u.abilities.find((x) => x.key === 'viper_corrosive_skin');
const toxin = (u: Unit) => u.abilities.find((x) => x.key === 'viper_nethertoxin');

/** Orbe: ataques que llevan Poison Attack. */
const orbAttacks = new WeakSet<object>();

defineAbility({
  key: 'viper_poison_attack', target: 'toggle',
  passive: (a) => ({
    name: 'poison_attack_orb',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (u.isBot) a.toggled = true;
      if (!a.toggled || u.kind === 'illusion' || t.team === u.team || u.has(ST.silenced)) return;
      if (!t.isHeroLike && t.kind !== 'creep' && t.kind !== 'summon') return;
      const mc = manaCostOf(a);
      if (u.mana < mc) return;
      u.mana -= mc;
      orbAttacks.add(ev);
    },
    onAttackLanded(_m, ev) {
      if (!orbAttacks.has(ev)) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (!canDebuff(u, t, a)) return;
      const max = val(a, 'max_stacks');
      const cur = t.findMod('poison_attack', u);
      const stacks = Math.min(max, (cur?.stacks ?? 0) + 1);
      const m = debuff(u, t, a, {
        name: 'poison_attack', duration: dur(a, 'duration'), stacks, interval: 1, fx: 'poison',
        props: (mm) => ({
          msSlow: mm.stacks * val(a, 'movement_speed') / 100,
          magicResist: -mm.stacks * val(a, 'magic_resistance') / 100,
          armor: -mm.stacks * val(a, 'shard_armor_reduction'),
        }),
        onInterval(mm) { damage(u, mm.owner as Unit, mm.stacks * dmg(a, 'damage'), 'magical', a, { noProc: true }); },
      });
      if (m) { m.stacks = stacks; m.remaining = m.duration = dur(a, 'duration') * (1 - t.s.statusResist); t.refreshStats(); }
    },
  }),
});

/** Charco de Nethertoxin: daño que crece con el tiempo dentro y ralentiza el ataque. */
function nethertoxinAt(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const w = u.w;
  const inside = new Map<number, { since: number; seen: number }>();
  let radius = val(a, 'radius');
  const grow = val(a, 'radius_increase'), every = val(a, 'expand_interval');
  let growAcc = 0, dmgAcc = 0;
  const step = 0.1;
  w.emit({ n: 'nethertoxin', x, y, r: radius, d: dur(a, 'duration'), t: u.team });
  w.addZone({
    fx: 'nethertoxin', x, y, r: radius, team: u.team, interval: step, duration: dur(a, 'duration'),
    onInterval(z) {
      if (grow > 0 && every > 0) {
        growAcc += step;
        if (growAcc >= every) { growAcc -= every; radius += grow; z.r = radius; }
      }
      dmgAcc += step;
      const tickDmg = dmgAcc >= 0.5;
      if (tickDmg) dmgAcc -= 0.5;
      for (const e of w.enemiesIn(u.team, x, y, radius)) {
        let st = inside.get(e.id);
        if (!st || w.time - st.seen > 0.25) { st = { since: w.time, seen: w.time }; inside.set(e.id, st); }
        st.seen = w.time;
        debuff(u, e, a, { name: 'nethertoxin', duration: 0.3, fx: 'slow', props: { attackSlow: val(a, 'attack_slow') } });
        if (tickDmg) {
          const k = Math.min(1, (w.time - st.since) / val(a, 'max_duration'));
          const dps = dmg(a, 'min_damage') + (dmg(a, 'max_damage') - dmg(a, 'min_damage')) * k;
          damage(u, e, dps * 0.5, 'magical', a, { noProc: true });
        }
      }
    },
  });
}

defineAbility({
  key: 'viper_nethertoxin', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    u.w.emit({ n: 'nethertoxin_proj', x: u.x, y: u.y, x2: t.x, y2: t.y, u: u.id });
    u.w.after(d / val(a, 'projectile_speed'), () => nethertoxinAt(a, t.x, t.y));
  },
});

/** Efecto de Corrosive Skin sobre quien daña a Viper. */
function corrode(a: AbilityInst, e: Unit, duration: number) {
  const u = a.owner as Unit;
  debuff(u, e, a, {
    name: 'corrosive_skin', duration, interval: 1, fx: 'poison',
    props: { attackSlow: val(a, 'bonus_attack_speed') },
    onInterval(m: Modifier) { damage(u, m.owner as Unit, dmg(a, 'damage'), 'magical', a, { noProc: true, data: { corrosive: true } }); },
  });
}

defineAbility({
  key: 'viper_corrosive_skin', target: 'passive',
  passive: (a) => ({
    name: 'corrosive_skin_passive',
    props: { magicResist: val(a, 'bonus_magic_resistance') / 100 },
    onTakeDamage(m, ev) {
      const u = m.owner as Unit;
      const s = ev.source as Unit | null;
      if (!s || s.team === u.team || ev.data?.corrosive || !s.alive) return;
      if (Math.hypot(s.x - u.x, s.y - u.y) > val(a, 'max_range')) return;
      if (s.kind === 'fountain' || s.kind === 'throne') return;
      corrode(a, s, dur(a, 'duration'));
    },
  }),
});

defineAbility({
  key: 'viper_nose_dive', target: 'point', castBeyond: true, ai: { role: 'aoe' },
  aoe: (a) => val(a, 'corrosive_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const range = val(a, 'abilitycastrange') + u.s.castRange;
    let dx = t.x - u.x, dy = t.y - u.y;
    const d = Math.hypot(dx, dy) || 1;
    const go = Math.min(range, d);
    dx /= d; dy /= d;
    dash(u, u.x + dx * go, u.y + dy * go, val(a, 'dive_speed') * 2, a, {
      name: 'nose_dive', states: ST.flying,
      onArrive(v) {
        const tx = toxin(v), sk = skin(v);
        if (tx && tx.level > 0) nethertoxinAt(tx, v.x, v.y);
        v.w.emit({ n: 'nose_dive', x: v.x, y: v.y, r: val(a, 'corrosive_radius'), t: v.team });
        if (sk && sk.level > 0) {
          for (const e of v.w.enemiesIn(v.team, v.x, v.y, val(a, 'corrosive_radius'))) corrode(sk, e, val(a, 'effect_duration'));
        }
      },
    });
  },
});

defineAbility({
  key: 'viper_predator', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'predator',
    // Más daño de ataque cuanto más vida le falta al objetivo.
    onAttackStart(_m, ev) {
      const t = ev.target as Unit;
      if (t.team === (ev.attacker as Unit).team) return;
      ev.damage += (1 - t.hp / t.s.maxHp) * 100 * val(a, 'damage');
    },
  }),
});

defineAbility({
  key: 'viper_viper_strike', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'viper_strike', source: u, target: e, x: u.x, y: u.y,
      speed: val(a, 'projectile_speed'), dodgeable: true,
      onHit() {
        if (!canDebuff(u, e, a)) return true;
        const total = dur(a, 'duration');
        debuff(u, e, a, {
          name: 'viper_strike', duration: total, interval: 1, fx: 'poison', purgable: false,
          states: val(a, 'does_break') ? ST.broken : 0,
          // El ralentizado se reduce a lo largo de la duración.
          props: (m) => {
            const k = Math.max(0, m.remaining / Math.max(0.01, m.duration));
            return { msSlow: val(a, 'bonus_movement_speed') / 100 * k, attackSlow: val(a, 'bonus_attack_speed') * k };
          },
          onInterval(m) {
            damage(u, m.owner as Unit, dmg(a, 'damage'), 'magical', a, { noProc: true });
            (m.owner as Unit).refreshStats();
          },
        });
        return true;
      },
    });
  },
});

defineHero('viper', ['viper_poison_attack', 'viper_nethertoxin', 'viper_corrosive_skin', 'viper_nose_dive', 'viper_predator', 'viper_viper_strike'], {
  build: ['wraith_band', 'power_treads', 'dragon_lance', 'maelstrom', 'black_king_bar', 'ultimate_scepter', 'skadi'],
});
