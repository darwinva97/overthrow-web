import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { creditHero, damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, slow, stun } from './util';
import { botOnly, dist, enemyHeroes, netWorth, reveal } from './lib/a1';

const find = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Golpe de Jinada: daño físico extra ya sumado al ataque, aquí solo el robo de oro. */
function jinadaSteal(a: AbilityInst, t: Unit) {
  const u = a.owner as Unit;
  if (t.kind !== 'hero' || t.team === u.team) return;
  const g = Math.min(t.gold, Math.round(val(a, 'gold_steal')));
  if (g <= 0) return;
  t.gold -= g; u.gold += g;
  u.w.emit({ n: 'gold', x: t.x, y: t.y, v: g, u: u.id });
}

defineAbility({
  key: 'bounty_hunter_shuriken_toss', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const hit = new Set<number>();
    const throwAt = (from: { x: number; y: number }, e: Unit) => {
      hit.add(e.id);
      u.w.addProjectile({
        kind: 'track', fx: 'shuriken', source: u, target: e, x: from.x, y: from.y, speed: val(a, 'speed'), dodgeable: true,
        onHit() {
          damage(u, e, dmg(a, 'bonus_damage'), 'magical', a);
          if (e.alive) slow(u, e, a, 'shuriken_toss', val(a, 'slow_duration'), val(a, 'slow') / 100);
          // Scepter: aplica Jinada.
          const j = find(u, 'bounty_hunter_jinada');
          if (hasScepter(u) && j && j.level > 0 && e.alive) {
            damage(u, e, dmg(j, 'bonus_damage'), 'physical', j);
            jinadaSteal(j, e);
          }
          // Rebota a los objetivos con Track cercanos.
          const next = u.w.enemiesIn(u.team, e.x, e.y, val(a, 'bounce_aoe'))
            .filter((v) => !hit.has(v.id) && v.findMod('track', u)).sort((x, y) => dist(x, e) - dist(y, e))[0];
          if (next) throwAt(e, next);
          return true;
        },
      });
    };
    throwAt(u, t.unit as Unit);
  },
});

// Autolanzable: con el autocast activo (por defecto) el siguiente ataque tras el enfriamiento la aplica.
defineAbility({
  key: 'bounty_hunter_jinada', target: 'toggle',
  onLevelUp(a) { if (a.level === 1) a.toggled = true; },
  passive: (a) => ({
    name: 'jinada',
    onAttackStart(m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      m.data.proc = 0;
      if (!(a.toggled || u.isBot) || a.cd > 0 || t.team === u.team || u.kind !== 'hero' || ev.fake) return;
      if (!t.isHeroLike && t.kind !== 'creep' && t.kind !== 'summon') return;
      ev.damage += dmg(a, 'bonus_damage');
      m.data.proc = t.id;
      a.cd = cooldownOf(a);
    },
    onAttackLanded(m, ev) {
      if (m.data.proc !== ev.target.id || ev.missed) return;
      m.data.proc = 0;
      jinadaSteal(a, ev.target as Unit);
    },
  }),
});

/** Shadow Walk sobre `e` tras `fade` segundos. */
function shadowWalk(a: AbilityInst, src: Unit, e: Unit, fade: number) {
  const u = a.owner as Unit;
  u.w.emit({ n: 'fade', x: e.x, y: e.y, u: e.id });
  u.w.after(fade, () => {
    if (!e.alive) return;
    e.addMod({
      name: 'shadow_walk', duration: dur(a, 'duration'), fx: 'invis', states: ST.invisible | ST.noCollision,
      props: { msPct: val(a, 'bonus_move_speed_pct') / 100, incomingPct: -val(a, 'damage_reduction_pct') / 100 },
      data: { breaksOnAttack: true },
      // El ataque que rompe la invisibilidad aturde (también si es a distancia).
      onAttackStart(_m, ev) {
        const tid = ev.target.id;
        if (ev.target.team === e.team) return;
        e.addMod({
          name: 'shadow_walk_strike', duration: 3,
          onAttackLanded(mm, aev) {
            if (aev.target.id !== tid) return;
            if (!aev.missed) stun(u, aev.target as Unit, val(a, 'stun_duration'), a);
            mm.remaining = 0.001;
          },
        }, src, a);
      },
    }, src, a);
  });
}

defineAbility({
  key: 'bounty_hunter_wind_walk', target: 'none', ai: { role: 'escape', selfRadius: 900 },
  onSpellStart(a) { shadowWalk(a, a.owner as Unit, a.owner as Unit, val(a, 'fade_time')); },
});

defineAbility({
  key: 'bounty_hunter_wind_walk_ally', target: 'unit', team: 'ally',
  // No rompe la invisibilidad de Bounty Hunter.
  passive: (a) => {
    a.data.keepInvis = true;
    return botOnly(a, (u) => {
      const ally = u.w.alliesIn(u.team, u.x, u.y, 650, { heroes: true })
        .find((h) => h !== u && h.kind === 'hero' && h.hp / h.s.maxHp < 0.4 && enemyHeroes(h, 700).length);
      return ally ? { unit: ally } : null;
    });
  },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const ww = find(u, 'bounty_hunter_wind_walk');
    if (!ww || ww.level <= 0) return;
    shadowWalk(ww, u, t.unit as Unit, val(a, 'fade_time'));
  },
});

defineAbility({
  key: 'bounty_hunter_big_game_hunter', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'big_game_hunter',
    // Más oro por muerte o asistencia si la víctima es de los 3 con más patrimonio de su equipo.
    onAnyDeath(m, victim, killer) {
      const u = m.owner as Unit;
      if (victim.kind !== 'hero' || victim.team === u.team) return;
      const kh = creditHero(killer as Unit);
      const assist = kh !== u && (victim.damagedBy.get(u.id) ?? -99) >= u.w.time - 15;
      if (kh !== u && !assist) return;
      const team = u.w.list.filter((h) => h.kind === 'hero' && h.team === victim.team).sort((x, y) => netWorth(y) - netWorth(x));
      if (team.indexOf(victim as Unit) > 2) return;
      const base = kh === u ? 110 + 8 * victim.level : 40 + 4 * victim.level;
      const g = Math.round(base * val(a, 'kill_assist_gold_bonus_percent') / 100);
      u.gold += g;
      u.w.emit({ n: 'gold', x: victim.x, y: victim.y, v: g, u: u.id });
    },
  }),
});

defineAbility({
  key: 'bounty_hunter_track', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  passive: (a) => { a.data.keepInvis = true; return null; },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = dur(a, 'duration');
    reveal(u, e, d, a);
    debuff(u, e, a, {
      name: 'track', duration: d, fx: 'track',
      props: { incomingPct: val(a, 'target_damage_amp') / 100 },
      onDeath(m, killer) {
        const v = m.owner as Unit;
        if (!killer || killer.team === v.team) return;
        u.gold += val(a, 'bonus_gold_self');
        u.w.emit({ n: 'gold', x: v.x, y: v.y, v: val(a, 'bonus_gold_self'), u: u.id });
        for (const h of u.w.alliesIn(u.team, v.x, v.y, val(a, 'bonus_gold_radius'), { heroes: true })) {
          if (h !== u && h.kind === 'hero') h.gold += val(a, 'bonus_gold');
        }
      },
    });
  },
});

defineHero('bounty_hunter', ['bounty_hunter_shuriken_toss', 'bounty_hunter_jinada', 'bounty_hunter_wind_walk', 'bounty_hunter_wind_walk_ally', 'bounty_hunter_big_game_hunter', 'bounty_hunter_track'], {
  build: ['wraith_band', 'phase_boots', 'orchid', 'desolator', 'black_king_bar', 'bloodthorn', 'nullifier'],
});
