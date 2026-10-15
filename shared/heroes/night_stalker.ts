import { cooldownOf, defineAbility, defineHero, dmg, hasScepter, val } from '../sim/abilities';
import { damage, heal, giveMana } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, slow, stun } from './util';

/** Noche para Night Stalker: la del mundo o la que fuerza Dark Ascension. */
const isNight = (u: Unit) => u.w.isNight() || !!u.findMod('dark_ascension');

function voidOn(u: Unit, a: AbilityInst, e: Unit) {
  const night = isNight(u);
  damage(u, e, dmg(a, 'damage'), 'magical', a);
  const d = (night ? val(a, 'duration_night') : val(a, 'duration_day')) * a.upg.dur;
  slow(u, e, a, 'void', d, val(a, 'movespeed_slow') / 100, val(a, 'attackspeed_slow'));
  if (night) stun(u, e, 0.1, a);
}

defineAbility({
  key: 'night_stalker_void', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'cast_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.emit({ n: 'void', x: e.x, y: e.y, u: e.id, r: val(a, 'cast_radius') || 100, t: u.team });
    // Shard: afecta a todos los enemigos alrededor del objetivo.
    const r = val(a, 'cast_radius');
    const list = r > 0 ? u.w.enemiesIn(u.team, e.x, e.y, r) : [e];
    if (!list.includes(e)) list.push(e);
    for (const v of list) voidOn(u, a, v);
  },
});

defineAbility({
  key: 'night_stalker_crippling_fear', target: 'none', ai: { role: 'disable', selfRadius: 320 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = (isNight(u) ? val(a, 'duration_night') : val(a, 'duration_day')) * a.upg.dur;
    const tick = val(a, 'tick_rate');
    u.addMod({
      name: 'crippling_fear_aura', duration: d, fx: 'crippling_fear',
      aura: {
        radius: val(a, 'radius'), team: 'enemy',
        apply: (_m, t) => ({
          name: 'crippling_fear', debuff: true, fx: 'silence',
          states: t.has(ST.magicImmune) ? 0 : ST.silenced,
          interval: tick,
          onInterval(mm) { damage(u, mm.owner as Unit, dmg(a, 'dps') * tick, 'magical', a, { noProc: true }); },
        }),
      },
    }, u, a);
  },
});

// Pasiva: cura por golpe y, con enfriamiento, el golpe a un héroe restaura vida y maná.
defineAbility({
  key: 'night_stalker_midnight_feast', target: 'passive',
  passive: (a) => ({
    name: 'midnight_feast',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.team === u.team || !(t.isHeroLike || t.kind === 'creep')) return;
      heal(u, val(a, 'attack_heal') * a.upg.dmg, u, true);
      if (a.cd > 0 || t.kind !== 'hero') return;
      a.cd = cooldownOf(a);
      heal(u, u.s.maxHp * val(a, 'hp_restore') / 100, u);
      giveMana(u, u.s.maxMana * val(a, 'mp_restore') / 100);
    },
  }),
});

defineAbility({
  key: 'night_stalker_hunter_in_the_night', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'hunter_in_the_night',
    props: (m) => isNight(m.owner as Unit) ? {
      msPct: val(a, 'bonus_movement_speed_pct_night') / 100,
      attackSpeed: val(a, 'bonus_attack_speed_night'),
      statusResist: val(a, 'bonus_status_resist_night') / 100,
    } : {},
    // Recalcula al cambiar el día por la noche.
    onTick(m) {
      const u = m.owner as Unit;
      const n = isNight(u);
      if (n !== m.data.night) { m.data.night = n; u.refreshStats(); }
    },
    // Scepter: matar a un héroe reinicia las habilidades básicas.
    onKill(m, v) {
      const u = m.owner as Unit;
      if (!hasScepter(u) || v.kind !== 'hero' || v.team === u.team) return;
      for (const x of u.abilities) if (!x.impl.ult && !x.def.ult) x.cd = 0;
    },
  }),
});

defineAbility({
  key: 'night_stalker_darkness', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.w.emit({ n: 'darkness', x: u.x, y: u.y, r: 1800, t: u.team });
    // El motor no permite forzar la noche global: la noche solo cuenta para Night Stalker.
    u.addMod({
      name: 'dark_ascension', duration: val(a, 'duration') * a.upg.dur, fx: 'dark_ascension',
      states: ST.flying,
      props: { damage: dmg(a, 'bonus_damage') },
    }, u, a);
    u.refreshStats();
    // Los enemigos ven menos durante la oscuridad (aproximación local).
    for (const e of u.w.list) {
      if (e.team === u.team || !e.alive || !e.isHeroLike) continue;
      debuff(u, e, a, { name: 'darkness_blind', duration: val(a, 'duration'), props: { vision: -Math.max(0, e.s.vision - e.base.nightVision) } });
    }
  },
});

defineHero('night_stalker', ['night_stalker_void', 'night_stalker_crippling_fear', 'night_stalker_midnight_feast', 'night_stalker_hunter_in_the_night', 'night_stalker_darkness'], {
  build: ['bracer', 'phase_boots', 'echo_sabre', 'black_king_bar', 'basher', 'assault', 'abyssal_blade'],
});
