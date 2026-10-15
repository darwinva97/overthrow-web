import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, isItem, manaCostOf, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst, AttackEvent } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, addStacks, revealTo } from './lib/a7';
import { debuff, silence } from './util';

const CURSE = 'silencer_curse_of_the_silent';

/** Arcane Curse: daño en el tiempo y ralentizado; se alarga al lanzar hechizos y se pausa silenciado. */
function arcaneCurse(u: Unit, e: Unit, a: AbilityInst, duration: number, pause = true) {
  return debuff(u, e, a, {
    name: 'arcane_curse', duration, fx: 'arcane_curse', interval: 1,
    purgable: val(a, 'undispellable') <= 0,
    props: { msSlow: Math.abs(val(a, 'movespeed')) / 100 },
    onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'damage'), 'magical', a, { noProc: true }); },
    onTick(m, dt) { if (pause && (m.owner as Unit).has(ST.silenced)) m.remaining += dt; },
    onAbilityExecuted(m, ab) {
      if (isItem(ab)) return;
      const add = val(a, 'penalty_duration') * val(a, 'penalty_multiplier');
      m.remaining += add; m.duration += add;
    },
  });
}

defineAbility({
  key: 'silencer_curse_of_the_silent', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.emit({ n: 'aoe', x: t.x, y: t.y, r, t: u.team, c: 'arcane_curse' });
    for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
      damage(u, e, dmg(a, 'application_damage'), 'magical', a);
      arcaneCurse(u, e, a, dur(a, 'duration'));
    }
  },
});

// Ataques marcados como Glaive (se pagó el maná al lanzarlos).
const glaived = new WeakSet<AttackEvent>();

/** Daño e robo de inteligencia de un Glaive sobre `t`. */
function glaiveHit(u: Unit, a: AbilityInst, t: Unit) {
  damage(u, t, u.s.int * val(a, 'intellect_damage_pct') / 100 * a.upg.dmg, 'magical', a);
  if (t.kind !== 'hero' || u.kind !== 'hero') return;
  const n = val(a, 'int_steal');
  const d = val(a, 'int_steal_duration');
  addStacks(t, u, a, { name: 'glaives_int_loss', debuff: true, purgable: false, props: (m) => ({ int: -m.stacks }) }, d, n);
  addStacks(u, u, a, { name: 'glaives_int_gain', props: (m) => ({ int: m.stacks }) }, d, n);
}

defineAbility({
  key: 'silencer_glaives_of_wisdom', target: 'toggle',
  // Autolanzamiento activado al aprenderla (los bots no gestionan autocasts de ataque a distancia).
  onLevelUp(a) { if (a.level === 1) a.toggled = true; },
  onToggle(a, on) { if (!on && (a.owner as Unit).isBot) a.toggled = true; },
  passive: (a) => ({
    name: 'glaives_of_wisdom',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit;
      if (!a.toggled || ev.fake || u.kind === 'illusion') return;
      const cost = manaCostOf(a);
      if (u.mana < cost || u.has(ST.silenced)) return;
      u.mana -= cost;
      glaived.add(ev);
    },
    onAttackLanded(_m, ev) {
      if (!glaived.has(ev)) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      glaiveHit(u, a, t);
      // Shard: rebota a otro enemigo cercano.
      if (hasShard(u)) {
        const others = u.w.enemiesIn(u.team, t.x, t.y, val(a, 'bounce_range')).filter((e) => e !== t && e.kind !== 'ward');
        for (let i = 0; i < val(a, 'bounce_count') && others.length; i++) {
          const o = others.splice(Math.floor(u.w.rng() * others.length), 1)[0];
          u.w.emit({ n: 'glaive_bounce', x: t.x, y: t.y, x2: o.x, y2: o.y, u: t.id, u2: o.id });
          glaiveHit(u, a, o);
        }
      }
    },
  }),
});

/** Detona Last Word: daño según la diferencia de inteligencia y silencio. */
function lastWordFire(u: Unit, a: AbilityInst, e: Unit) {
  const r = val(a, 'radius');
  const targets = r > 0 ? u.w.enemiesIn(u.team, e.x, e.y, r) : [e];
  if (!targets.includes(e) && e.alive) targets.push(e);
  u.w.emit({ n: 'last_word', x: e.x, y: e.y, r: r || 100, t: u.team });
  for (const v of targets) {
    const diff = Math.max(0, u.s.int - v.s.int);
    damage(u, v, dmg(a, 'damage') + diff * val(a, 'int_multiplier'), 'magical', a);
    silence(u, v, dur(a, 'debuff_duration'), a, 'last_word_silence');
  }
}

defineAbility({
  key: 'silencer_last_word', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = val(a, 'duration');
    const m = debuff(u, e, a, {
      name: 'last_word', duration: d, fx: 'last_word',
      onAbilityExecuted(mm, ab) { if (isItem(ab)) return; mm.data.fired = true; lastWordFire(u, a, mm.owner as Unit); (mm.owner as Unit).removeMod(mm); },
      onDestroy(mm) {
        const v = mm.owner as Unit;
        if (!mm.data.fired && v.alive && mm.remaining <= 0.05) lastWordFire(u, a, v);
      },
    });
    if (m) revealTo(e, u.team, d, u, a);
  },
});

defineAbility({
  key: 'silencer_brain_drain', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'brain_drain',
    // Recibe menos daño de silenciados.
    onIncomingDamage(m, ev) {
      const src = ev.source as Unit | null;
      if (src && src.team !== (m.owner as Unit).team && src.has(ST.silenced)) ev.amount *= 1 - val(a, 'damage_pct') / 100;
    },
    // Hace más daño a silenciados (lo aplica en la víctima, antes del daño).
    aura: {
      radius: 0, global: true, team: 'enemy', heroesOnly: true,
      apply: (mm) => ({
        name: 'brain_drain_mark',
        onIncomingDamage(_x, ev) {
          if (ev.source === mm.owner && ev.target.has(ST.silenced)) ev.amount *= 1 + val(a, 'damage_pct') / 100;
        },
      }),
    },
    onAnyDeath(m, victim) {
      const u = m.owner as Unit;
      if (victim.kind !== 'hero' || victim.team === u.team || u.kind !== 'hero') return;
      const near = Math.hypot(victim.x - u.x, victim.y - u.y) <= val(a, 'permanent_int_steal_range');
      const marked = victim.mods.some((x) => x.caster === u && x.debuff);
      if (!near && !marked) return;
      let n = val(a, 'permanent_int_steal_amount');
      if (victim.has(ST.silenced)) n += val(a, 'silenced_bonus_int_steal_amount');
      u.permInt += n;
      victim.permInt = Math.max(-victim.hero!.int + 1, victim.permInt - n);
      u.refreshStats();
    },
  }),
});

defineAbility({
  key: 'silencer_global_silence', target: 'none', ult: true, ai: { role: 'disable', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = dur(a, 'abilityduration');
    const curse = abil(u, CURSE);
    u.w.emit({ n: 'global_silence', x: u.x, y: u.y, u: u.id, t: u.team });
    for (const e of u.w.list) {
      if (!e.alive || e.team === u.team || e.kind === 'fountain' || e.kind === 'throne' || e.kind === 'orb' || e.kind === 'kobold') continue;
      silence(u, e, d, a, 'global_silence');
      if (hasScepter(u) && e.kind === 'hero' && curse && curse.level > 0) arcaneCurse(u, e, curse, d, false);
    }
  },
});

defineHero('silencer', [
  'silencer_curse_of_the_silent', 'silencer_glaives_of_wisdom', 'silencer_last_word', 'silencer_brain_drain', 'silencer_global_silence',
], {
  build: ['null_talisman', 'power_treads', 'force_staff', 'hurricane_pike', 'black_king_bar', 'sheepstick', 'refresher'],
});
