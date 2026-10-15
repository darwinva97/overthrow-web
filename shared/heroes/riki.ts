import { castRangeOf, defineAbility, defineHero, dur, val } from '../sim/abilities';
import { creditHero, landAttack, makeAttack } from '../sim/combat';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, slow } from './util';
import { behind, rollMiss } from './lib/a6';

defineAbility({
  key: 'riki_smoke_screen', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const miss = val(a, 'miss_rate') / 100;
    const armor = val(a, 'armor_reduction');
    u.w.addZone({
      fx: 'smoke_screen', x: t.x, y: t.y, r, team: u.team, interval: 0.1, duration: dur(a, 'abilityduration'),
      onInterval(z) {
        for (const e of u.w.enemiesIn(u.team, z.x, z.y, r)) {
          debuff(u, e, a, {
            name: 'smoke_screen', duration: 0.2, fx: 'smoke', states: ST.silenced,
            props: armor ? { armor: -armor } : undefined,
            onAttackStart(_m, ev) { rollMiss(ev, miss); },
          });
        }
      },
    });
  },
});

/** Ataque de Riki con daño extra (Blink Strike, Tricks of the Trade). */
function rikiAttack(u: Unit, e: Unit, setDamage: number | null, bonus: number) {
  if (!e.alive || !u.w.targetable(e)) return;
  const ev = makeAttack(u, e, true);
  if (setDamage !== null) ev.damage = setDamage + ev.damage - ((u.s.dmgMin + u.s.dmgMax) / 2 + u.s.dmgBonus);
  ev.damage += bonus;
  landAttack(ev);
}

defineAbility({
  key: 'riki_blink_strike', target: 'unit', team: 'any', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.emit({ n: 'blink', x: u.x, y: u.y, u: u.id });
    // Aparece a su espalda.
    const back = e.radius + u.radius;
    u.w.teleport(u, e.x - Math.cos(e.facing) * back, e.y - Math.sin(e.facing) * back);
    u.facing = Math.atan2(e.y - u.y, e.x - u.x);
    if (e.team === u.team) return;
    slow(u, e, a, 'blink_strike_slow', val(a, 'slow'), val(a, 'slow_pct_tooltip') / 100);
    rikiAttack(u, e, null, val(a, 'bonus_damage'));
    u.w.issueOrder(u, { type: 'attack', target: e.id });
  },
});

defineAbility({
  key: 'riki_tricks_of_the_trade', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  channel: (a) => val(a, 'abilitychanneltime') + val(a, 'scepter_bonus_duration'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    // Scepter: se esconde dentro de un aliado cercano al punto.
    let host: Unit | null = null;
    if (val(a, 'pocket_riki_enabled') > 0) {
      host = u.w.alliesIn(u.team, t.x, t.y, 150, { heroes: true }).find((x) => x !== u && x.kind === 'hero') ?? null;
    }
    const d = Math.min(castRangeOf(a), Math.hypot(t.x - u.x, t.y - u.y));
    const ang = Math.atan2(t.y - u.y, t.x - u.x);
    if (!host) u.w.teleport(u, u.x + Math.cos(ang) * d, u.y + Math.sin(ang) * d);
    u.w.disjoint(u);
    a.data.host = host?.id ?? 0;
    a.data.acc = 0;
    if (host) host.addMod({ name: 'tricks_host', duration: val(a, 'abilitychanneltime') + val(a, 'scepter_bonus_duration'), props: { msPct: val(a, 'scepter_movespeed') / 100 } }, u, a);
    u.addMod({
      name: 'tricks_of_the_trade', duration: val(a, 'abilitychanneltime') + val(a, 'scepter_bonus_duration'), fx: 'tricks',
      states: ST.invulnerable | ST.untargetable | ST.noCollision, purgable: false,
    }, u, a);
    if (val(a, 'dispel') > 0) u.purge(true, false);
  },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const host = a.data.host ? u.w.units.get(a.data.host) : null;
    if (host) { if (!host.alive) { u.w.interruptCast(u, true); return; } u.x = host.x; u.y = host.y; }
    const total = val(a, 'abilitychanneltime') + val(a, 'scepter_bonus_duration');
    const count = val(a, 'attack_count') + val(a, 'scepter_bonus_attacks');
    const every = total / Math.max(1, count);
    a.data.acc += dt;
    if (a.data.acc < every) return;
    a.data.acc -= every;
    const pool = u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius')).filter((e) => e.kind !== 'ward' && u.w.canSee(u.team, e));
    const heroes = pool.filter((e) => e.isHeroLike);
    const list = (heroes.length ? heroes : pool).sort(() => u.w.rng() - 0.5).slice(0, val(a, 'interval_targets'));
    const fixed = val(a, 'attack_damage') + ((u.s.dmgMin + u.s.dmgMax) / 2) * val(a, 'base_attack_damage_pct') / 100;
    for (const e of list) {
      // Golpea por la espalda.
      const back = e.radius + 10;
      const ox = u.x, oy = u.y;
      u.x = e.x - Math.cos(e.facing) * back; u.y = e.y - Math.sin(e.facing) * back;
      u.facing = e.facing;
      rikiAttack(u, e, fixed, 0);
      u.x = ox; u.y = oy;
    }
  },
  onChannelEnd(a) {
    const u = a.owner as Unit;
    u.removeModsByName('tricks_of_the_trade');
    const host = a.data.host ? u.w.units.get(a.data.host) : null;
    if (host) { host.removeModsByName('tricks_host'); u.w.teleport(u, host.x, host.y); }
  },
});

defineAbility({
  key: 'riki_innate_backstab', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'backstab',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.team === u.team || !behind(u, t, val(a, 'backstab_angle'))) return;
      ev.damage += u.s.agi * val(a, 'damage_multiplier');
      u.w.emit({ n: 'backstab', x: t.x, y: t.y, u: t.id });
    },
  }),
});

defineAbility({
  key: 'riki_backstab', target: 'passive', ult: true,
  passive: (a) => ({
    name: 'cloak_and_dagger', data: { last: -99 },
    props: (m) => (m.states ? { msPct: val(a, 'invis_movespeed_bonus_percent') / 100 } : {}),
    onAttackStart(m) {
      m.data.last = (m.owner as Unit).w.time;
      if (m.states) { m.states = 0; (m.owner as Unit).refreshStats(); }
    },
    onTick(m) {
      const u = m.owner as Unit;
      const want = u.w.time - m.data.last >= val(a, 'fade_delay') ? ST.invisible : 0;
      if ((m.states ?? 0) !== want) { m.states = want; u.refreshStats(); }
    },
    onAnyDeath(m, victim, killer) {
      // Experiencia extra por muertes y asistencias de héroes.
      const u = m.owner as Unit;
      if (u.kind !== 'hero' || victim.kind !== 'hero' || victim.team === u.team) return;
      if (creditHero(killer as Unit | null) === u) u.addXp(val(a, 'bonus_xp_kill'));
      else if ((u.w.time - (victim.damagedBy.get(u.id) ?? -99)) <= 15 || Math.hypot(victim.x - u.x, victim.y - u.y) <= 1200) u.addXp(val(a, 'bonus_xp_assist'));
    },
  }),
});

defineHero('riki', ['riki_smoke_screen', 'riki_blink_strike', 'riki_tricks_of_the_trade', 'riki_innate_backstab', 'riki_backstab'], {
  build: ['wraith_band', 'power_treads', 'diffusal_blade', 'sange_and_yasha', 'basher', 'black_king_bar', 'skadi', 'abyssal_blade'],
});
