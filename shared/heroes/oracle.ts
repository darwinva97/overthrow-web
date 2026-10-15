import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage, heal, kill } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff } from './util';
import { allyRedirect } from './lib/a6';

// Fortune's End: canaliza y, al soltar (o al interrumpirse), lanza el rayo.
function releaseFortune(a: AbilityInst) {
  const u = a.owner as Unit;
  const t = u.w.units.get(a.data.target);
  if (!t || !t.alive) return;
  const ch = Math.max(0.01, val(a, 'channel_time'));
  const frac = Math.min(1, (u.w.time - a.data.start) / ch);
  const rootDur = val(a, 'minimum_purge_duration') + (val(a, 'maximum_purge_duration') - val(a, 'minimum_purge_duration')) * frac;
  u.w.addProjectile({
    kind: 'track', fx: 'fortunes_end', source: u, target: t, x: u.x, y: u.y, speed: val(a, 'bolt_speed'), dodgeable: false,
    onHit() {
      const r = val(a, 'radius');
      u.w.emit({ n: 'fortunes_end', x: t.x, y: t.y, r, t: u.team });
      if (t.team === u.team) {
        for (const al of u.w.alliesIn(u.team, t.x, t.y, r)) al.purge(true, false);
        return true;
      }
      const constant = val(a, 'purge_constantly') > 0;
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        e.purge(false, true);
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        debuff(u, e, a, {
          name: 'fortunes_end_root', duration: rootDur * a.upg.dur, states: ST.rooted, fx: 'root',
          interval: constant ? 0.25 : undefined,
          onInterval: constant ? (m) => (m.owner as Unit).purge(false, true) : undefined,
        });
      }
      return true;
    },
  });
}

defineAbility({
  key: 'oracle_fortunes_end', target: 'unit', team: 'any', reflectable: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  channel: (a) => val(a, 'channel_time'),
  onSpellStart(a, t) {
    a.data.target = (t.unit as Unit)?.id ?? 0;
    a.data.start = (a.owner as Unit).w.time;
    // Reflejado (Lotus): sin canalización, se suelta al momento.
    if (a.temp) releaseFortune(a);
  },
  onChannelEnd(a) { releaseFortune(a); },
});

defineAbility({
  key: 'oracle_fates_edict', target: 'unit', team: 'any', allowSelf: true, reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const spec = {
      name: 'fates_edict', duration: dur(a, 'duration'), fx: 'fates_edict', states: ST.disarmed,
      props: { magicResist: val(a, 'magic_damage_resistance_pct_tooltip') / 100 },
    };
    if (e.team === u.team) e.addMod({ ...spec, purgable: true }, u, a);
    else debuff(u, e, a, spec);
  },
});

defineAbility({
  key: 'oracle_purifying_flames', target: 'unit', team: 'any', allowSelf: true, reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const enemy = e.team !== u.team;
    damage(u, e, dmg(a, 'damage') * (enemy ? val(a, 'damage_modifier') : 1), 'magical', a);
    if (!e.alive) return;
    const tick = val(a, 'tick_rate');
    const hps = val(a, 'heal_per_second') * a.upg.dmg;
    e.addMod({
      name: 'purifying_flames', duration: val(a, 'duration'), interval: tick, purgable: true, fx: 'purifying_flames',
      data: { multi: true },
      onInterval(m) { heal(m.owner as Unit, hps * tick, u, true); },
    }, u, a);
  },
});

defineAbility({
  key: 'oracle_rain_of_destiny', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const tick = val(a, 'tick_rate');
    const amp = val(a, 'heal_amp') / 100;
    u.w.addZone({
      fx: 'rain_of_destiny', x: t.x, y: t.y, r, team: u.team, interval: tick, duration: dur(a, 'duration'),
      onInterval(z) {
        for (const e of u.w.enemiesIn(u.team, z.x, z.y, r)) {
          debuff(u, e, a, { name: 'rain_of_destiny', duration: tick + 0.1, props: { healAmp: -amp } });
          damage(u, e, dmg(a, 'damage') * tick, 'magical', a, { noProc: true });
        }
        for (const al of u.w.alliesIn(u.team, z.x, z.y, r)) {
          al.addMod({ name: 'rain_of_destiny_ally', duration: tick + 0.1, props: { healAmp: amp } }, u, a);
          heal(al, dmg(a, 'damage') * tick, u, true);
        }
      },
    });
  },
});

// Diviner's Deck (con Scepter): cada `duration` s roba una carta con un beneficio al azar.
const CARDS = ['spell_amp', 'int', 'heal_amp', 'barrier', 'gold'] as const;
defineAbility({
  key: 'oracle_diviners_deck', target: 'passive', noIllusion: true, requires: 'scepter',
  passive: (a) => (val(a, 'enabled') > 0 ? {
    name: 'diviners_deck', interval: val(a, 'duration'), data: { card: '' },
    props: (m) => {
      const u = m.owner as Unit;
      switch (m.data.card) {
        case 'spell_amp': return { spellAmp: val(a, 'spell_amplification') / 100 };
        case 'int': return { int: u.baseAttr('int') * val(a, 'int_bonus_pct') / 100 };
        case 'heal_amp': return { healAmp: val(a, 'heal_amplification') / 100 };
        default: return {};
      }
    },
    onCreated(m) { draw(m); },
    onInterval(m) { draw(m); },
    onTick(m, dt) {
      if (m.data.card !== 'barrier') return;
      m.data.regen = (m.data.regen ?? 0) + dt;
      if (m.data.regen >= val(a, 'barrier_restore_time')) { m.data.regen = 0; m.data.left = val(a, 'barrier_amount'); }
    },
    onIncomingDamage(m, ev) {
      if (m.data.card !== 'barrier' || ev.hpRemoval || !(m.data.left > 0)) return;
      const b = Math.min(m.data.left, ev.amount);
      ev.amount -= b; m.data.left -= b; m.data.regen = 0;
    },
    onKill(m, victim) {
      // Carta de oro: duplica el oro por muerte de héroe.
      const u = m.owner as Unit;
      if (m.data.card === 'gold' && victim.kind === 'hero') u.gold += (110 + 8 * victim.level) * val(a, 'gold_bonus_pct') / 100;
    },
  } : null),
});
function draw(m: { data: Record<string, any>; owner?: any }) {
  const u = m.owner as Unit;
  m.data.card = CARDS[Math.floor(u.w.rng() * CARDS.length)];
  m.data.left = 0; m.data.regen = 999;
  u.refreshStats();
}

defineAbility({
  key: 'oracle_false_promise', target: 'unit', team: 'ally', allowSelf: true, ult: true, ai: { role: 'heal' },
  passive: (a) => allyRedirect(a),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    e.purge(true, false, true);
    const amp = 1 + val(a, 'heal_amp_pct') / 100;
    e.removeModsByName('false_promise');
    e.addMod({
      name: 'false_promise', duration: dur(a, 'duration'), fx: 'false_promise', purgable: false,
      props: { armor: val(a, 'bonus_armor') },
      data: { dmg: 0, heal: 0, hp: e.hp, killer: 0 },
      onTick(m) {
        // La curación se acumula (amplificada) y la vida se congela.
        const v = m.owner as Unit;
        if (v.hp > m.data.hp) { m.data.heal += (v.hp - m.data.hp) * amp; v.hp = m.data.hp; }
        m.data.hp = Math.min(v.hp, v.s.maxHp);
      },
      onIncomingDamage(m, ev) {
        if (ev.amount <= 0) return;
        m.data.dmg += ev.amount;
        if (ev.source) m.data.killer = ev.source.id;
        ev.amount = 0;
      },
      onDestroy(m) {
        const v = m.owner as Unit;
        if (!v.alive) return;
        const net = m.data.heal - m.data.dmg;
        v.w.emit({ n: 'false_promise_end', x: v.x, y: v.y, u: v.id });
        if (net >= 0) { v.hp = Math.min(v.s.maxHp, v.hp + net); return; }
        v.hp += net;
        if (v.hp <= 0) { v.hp = 0; kill(v, v.w.units.get(m.data.killer) ?? null); }
      },
    }, u, a);
  },
});

// Prognosticate predice runas: en Overthrow no hay runas de río, así que no tiene efecto.
defineAbility({ key: 'oracle_prognosticate', target: 'passive', innate: true, passive: () => null });

defineHero('oracle', ['oracle_fortunes_end', 'oracle_fates_edict', 'oracle_purifying_flames', 'oracle_rain_of_destiny', 'oracle_diviners_deck', 'oracle_false_promise', 'oracle_prognosticate'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'aether_lens', 'ultimate_scepter', 'aeon_disk', 'octarine_core'],
});
