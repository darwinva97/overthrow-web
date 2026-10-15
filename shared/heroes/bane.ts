import { defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { creditHero, damage, giveMana, heal } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff } from './util';
import { botTick, dist, LOCKED, lockSub, unlockSub } from './lib/a1';

const find = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/**
 * Debuff de Bane: Ichor of Nyctasha alarga sus efectos según los Terrores del objetivo
 * (el motor aplica la resistencia de estado de forma global, aquí se compensa en la duración).
 */
function baneDebuff(u: Unit, t: Unit, a: AbilityInst, spec: ModSpec) {
  const terror = t.findMod('ichor_terror');
  const ichor = find(u, 'bane_ichor_of_nyctasha');
  if (terror && ichor && spec.duration && Number.isFinite(spec.duration)) {
    spec = { ...spec, duration: spec.duration * (1 + terror.stacks * val(ichor, 'status_resistance') / 100) };
  }
  return debuff(u, t, a, { ...spec, data: { ...(spec.data ?? {}), bane: true } });
}

defineAbility({
  key: 'bane_enfeeble', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const red = val(a, 'damage_reduction') / 100;
    baneDebuff(u, e, a, {
      name: 'enfeeble', duration: dur(a, 'duration'), interval: val(a, 'damage_tick_rate'), fx: 'slow',
      // Reducción porcentual de alcance: el motor solo suma alcance plano (aprox. sobre 600).
      props: { castRange: -6 * val(a, 'cast_reduction') },
      onAttackStart(_m, ev) { ev.damage *= 1 - red; },
      onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'enfeeble_tick_damage') * val(a, 'damage_tick_rate'), 'pure', a, { noProc: true }); },
    });
  },
});

defineAbility({
  key: 'bane_brain_sap', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const amount = dmg(a, 'brain_sap_damage');
    u.w.emit({ n: 'brain_sap', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
    heal(u, damage(u, e, amount, 'pure', a), u);
    // Shard: área alrededor del objetivo; los secundarios curan un 30%.
    const r = val(a, 'shard_radius');
    if (hasShard(u) && r > 0) {
      for (const v of u.w.enemiesIn(u.team, e.x, e.y, r)) {
        if (v === e) continue;
        heal(u, damage(u, v, amount, 'pure', a) * val(a, 'shard_secondary_target_heal_pct') / 100, u);
      }
    }
  },
});

/** Pesadilla: duerme y camina despacio; se despierta al recibir daño que no sea de Bane. */
function nightmare(a: AbilityInst, caster: Unit, t: Unit, duration: number, dx: number, dy: number) {
  const u = a.owner as Unit;
  const start = u.w.time;
  const spec: ModSpec = {
    name: 'nightmare', duration, fx: 'nightmare', states: ST.stunned,
    purgable: true,
    onCreated(m) { if (u.w.time - start < val(a, 'nightmare_invuln_time')) m.states = ST.stunned | ST.invulnerable; },
    onTick(m, dt) {
      const v = m.owner as Unit;
      if (m.states! & ST.invulnerable && u.w.time - start >= val(a, 'nightmare_invuln_time')) { m.states = ST.stunned; v.refreshStats(); }
      v.w.forceMove(v, v.x + dx * val(a, 'walk_speed') * dt, v.y + dy * val(a, 'walk_speed') * dt);
    },
    onTakeDamage(m, ev) {
      if (ev.source === u || ev.amount <= 0) return;
      m.remaining = 0.001;
    },
    // Un ataque directo pasa la pesadilla al atacante.
    onAttacked(m, ev) {
      const at = ev.attacker as Unit;
      if (at === u || ev.missed || at.kind === 'fountain' || !at.alive || at.findMod('nightmare')) return;
      const left = m.remaining;
      m.remaining = 0.001;
      if (at.isHeroLike || at.kind === 'creep' || at.kind === 'summon') nightmare(a, caster, at, left, dx, dy);
    },
  };
  if (t.cast) t.w.interruptCast(t, true);
  t.order = null; t.atk.phase = 0;
  const m = t.team === u.team ? t.addMod(spec, u, a) : baneDebuff(u, t, a, spec);
  if (m) {
    unlockSub(find(u, 'bane_nightmare_end'));
    t.refreshStats();
  }
  return m;
}

defineAbility({
  key: 'bane_nightmare', target: 'unit', team: 'any', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = dist(u, e) || 1;
    nightmare(a, u, e, dur(a, 'abilityduration'), (e.x - u.x) / d, (e.y - u.y) / d);
  },
});

const nightmares = (u: Unit) => u.w.list.filter((v) => v.alive && v.findMod('nightmare', u));

defineAbility({
  key: 'bane_nightmare_end', target: 'none', levelWith: 2, sub: true,
  hidden: (a) => !nightmares(a.owner as Unit).length,
  charges: () => LOCKED,
  passive: (a) => ({
    name: 'nightmare_end_watch', interval: 0.25,
    onCreated() { if (!nightmares(a.owner as Unit).length) lockSub(a); },
    onInterval() { if (!nightmares(a.owner as Unit).length) lockSub(a); },
    // Bots: despiertan a los aliados dormidos (la pesadilla pasa al que ataca).
    onTick: botTick(a, (u) => (nightmares(u).some((v) => v.team === u.team) ? {} : null)),
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    for (const v of nightmares(u)) { const m = v.findMod('nightmare', u); if (m) v.removeMod(m); }
    lockSub(a);
  },
});

defineAbility({
  key: 'bane_fiends_grip', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const ch = val(a, 'abilitychanneltime');
    const every = val(a, 'fiend_grip_tick_interval');
    const illus: Unit[] = [];
    a.data.illus = illus;
    a.data.channeling = !a.temp;
    // Scepter: ilusiones que también canalizan (si se interrumpen, mueren).
    const n = val(a, 'illusion_count');
    for (let i = 0; i < n && !a.temp; i++) {
      const ang = u.w.rng() * Math.PI * 2;
      const il = u.w.spawnIllusion(u, e.x + Math.cos(ang) * 200, e.y + Math.sin(ang) * 200, ch, -1, val(a, 'scepter_incoming_illusion_damage') / 100);
      il.facing = Math.atan2(e.y - il.y, e.x - il.x);
      il.addMod({
        name: 'fiends_grip_channel', duration: ch, states: ST.busy | ST.channeling,
        onTick(m) {
          const v = m.owner as Unit;
          if (v.has(ST.stunned) || v.has(ST.silenced) || v.has(ST.hexed)) { v.expireAt = u.w.time; }
        },
      }, u, a);
      illus.push(il);
    }
    const holding = () => (a.data.channeling && u.alive) || illus.some((i) => i.alive && i.expireAt > u.w.time);
    baneDebuff(u, e, a, {
      name: 'fiends_grip', duration: a.temp ? ch : ch + 0.1, interval: every, fx: 'dismember', states: ST.stunned,
      data: { strongPurgable: true },
      onInterval(m) {
        const v = m.owner as Unit;
        if (!a.temp && !holding()) { m.remaining = 0.001; return; }
        damage(u, v, dmg(a, 'fiend_grip_damage') * every, 'pure', a, { noProc: true });
        const mana = v.s.maxMana * val(a, 'fiend_grip_mana_drain') / 100 * every;
        const got = Math.min(v.mana, mana);
        v.mana -= got;
        giveMana(u, got);
      },
    });
    a.data.target = e.id;
  },
  onChannelEnd(a) {
    const u = a.owner as Unit;
    a.data.channeling = false;
    const illus: Unit[] = a.data.illus ?? [];
    if (illus.some((i) => i.alive && i.expireAt > u.w.time)) return;
    const e = u.w.units.get(a.data.target);
    const m = e?.findMod('fiends_grip', u);
    if (m) e!.removeMod(m);
  },
});

defineAbility({
  key: 'bane_ichor_of_nyctasha', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'ichor_of_nyctasha',
    // Terror permanente al morir un héroe enemigo a manos de Bane o con un debuff suyo.
    onAnyDeath(m, victim, killer) {
      const u = m.owner as Unit;
      if (victim.kind !== 'hero' || victim.team === u.team) return;
      const mine = creditHero(killer as Unit) === u || victim.mods.some((x) => x.caster === u && x.data.bane);
      if (!mine) return;
      const cur = victim.findMod('ichor_terror', u);
      const stacks = Math.min(val(a, 'max_terrors'), (cur?.stacks ?? 0) + 1);
      const t = victim.addMod({ name: 'ichor_terror', persistent: true, purgable: false, debuff: true, stacks }, u, a);
      t.stacks = stacks;
    },
  }),
});

defineHero('bane', ['bane_enfeeble', 'bane_brain_sap', 'bane_nightmare', 'bane_fiends_grip', 'bane_nightmare_end', 'bane_ichor_of_nyctasha'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'aether_lens', 'ultimate_scepter', 'black_king_bar', 'octarine_core'],
});
