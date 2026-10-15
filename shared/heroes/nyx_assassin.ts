import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { burnMana, damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, stun } from './util';
import { gate } from './lib/a5';

const burrowed = (u: Unit) => !!u.findMod('burrowed');
/** Burrow mejora alcances y enfriamientos (Impale y Mind Flare). */
function burrowAbility(u: Unit): AbilityInst | undefined {
  return burrowed(u) ? u.abilities.find((x) => x.key === 'nyx_assassin_burrow') : undefined;
}

defineAbility({
  key: 'nyx_assassin_impale', target: 'point', ai: { role: 'disable' },
  castRange: (a) => val(a, 'abilitycastrange') + (burrowAbility(a.owner as Unit) ? val(burrowAbility(a.owner as Unit)!, 'cast_range') : 0),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const b = burrowAbility(u);
    if (b) a.cd *= 1 - val(b, 'cooldown_reduction') / 100;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = val(a, 'length') + (b ? val(b, 'cast_range') : 0) + u.s.castRange;
    u.w.addProjectile({
      kind: 'linear', fx: 'impale', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'speed'), left: len, width: val(a, 'width'),
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.kind === 'ward' || (v.has(ST.magicImmune) && !a.def.bkbPierce)) return;
        stun(u, v, dur(a, 'duration'), a);
        // El daño llega al caer (medio segundo en el aire).
        u.w.after(0.52, () => { if (v.alive) damage(u, v, dmg(a, 'impale_damage'), 'magical', a); });
      },
    });
  },
});

defineAbility({
  key: 'nyx_assassin_jolt', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'aoe'),
  castRange: (a) => val(a, 'abilitycastrange') + (burrowAbility(a.owner as Unit) ? val(burrowAbility(a.owner as Unit)!, 'cast_range') : 0),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const r = val(a, 'aoe');
    const list = r > 0 ? u.w.enemiesIn(u.team, e.x, e.y, r, { heroes: true }) : [e];
    if (!list.includes(e)) list.push(e);
    const echo = u.findMod('nyx_damage_log');
    for (const v of list) {
      const log: Map<number, { t: number; d: number }[]> | undefined = echo?.data.log;
      const recent = (log?.get(v.id) ?? []).filter((x) => u.w.time - x.t <= val(a, 'damage_echo_duration'));
      const echoed = recent.reduce((s, x) => s + x.d, 0) * val(a, 'damage_echo_pct') / 100;
      log?.delete(v.id);
      u.w.emit({ n: 'mind_flare', x: v.x, y: v.y, u: v.id, t: u.team });
      damage(u, v, v.s.maxMana * val(a, 'max_mana_as_damage_pct') / 100 * a.upg.dmg + echoed, 'magical', a);
      burnMana(v, v.s.maxMana * val(a, 'mana_burn_pct') / 100);
    }
  },
});

defineAbility({
  key: 'nyx_assassin_spiked_carapace', target: 'none', ai: { role: 'buff', selfRadius: 400 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    a.data.keepInvis = true;
    const b = burrowAbility(u);
    if (b) {
      // Bajo tierra: aturde al instante a los enemigos cercanos.
      u.w.emit({ n: 'carapace_burst', x: u.x, y: u.y, r: val(b, 'carapace_radius'), t: u.team });
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(b, 'carapace_radius'))) stun(u, e, dur(a, 'stun_duration'), a);
      return;
    }
    const seen = new Set<number>();
    u.addMod({
      name: 'spiked_carapace', duration: val(a, 'reflect_duration'), fx: 'carapace',
      onIncomingDamage(_m, ev) {
        const src = ev.source as Unit | null;
        if (!src || src.team === u.team || ev.hpRemoval || seen.has(src.id) || src.kind === 'fountain') return;
        seen.add(src.id);
        const amount = ev.amount;
        ev.amount = 0;
        if (!src.has(ST.invulnerable)) {
          damage(u, src, amount * val(a, 'damage_reflect_pct') / 100, ev.type, a, { noProc: true });
          stun(u, src, dur(a, 'stun_duration'), a);
        }
      },
    }, u, a);
  },
});

// Scepter: se entierra (quieto, invisible, sin atacar, con reducción de daño).
defineAbility({
  key: 'nyx_assassin_burrow', target: 'none', ai: { role: 'aoe', selfRadius: 350 },
  hidden: (a) => burrowed(a.owner as Unit),
  passive: gate((a) => !burrowed(a.owner as Unit)),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'burrowed', fx: 'burrow',
      states: ST.rooted | ST.disarmed | ST.invisible,
      props: { incomingPct: -val(a, 'damage_reduction') / 100, hpRegenPct: val(a, 'health_regen_rate') / 100, manaRegen: u.s.maxMana * val(a, 'mana_regen_rate') / 100 },
      // Los bots salen cuando no hay enemigos cerca o van mal de vida.
      interval: 0.5,
      onInterval() {
        if (!u.isBot) return;
        const near = u.w.enemiesIn(u.team, u.x, u.y, 450, { heroes: true }).length;
        const un = u.abilities.find((x) => x.key === 'nyx_assassin_unburrow');
        if (un && (!near || u.hp < u.s.maxHp * 0.3)) u.w.issueOrder(u, { type: 'cast', slot: un.slot });
      },
    }, u, a);
  },
});

defineAbility({
  key: 'nyx_assassin_neuro_sting', target: 'passive', innate: true,
  passive: () => ({
    name: 'nyx_damage_log', data: { log: new Map() },
    onDealDamage(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      if (t.team === u.team || ev.amount <= 0) return;
      // Burn de maná proporcional al daño y registro para Mind Flare.
      const ns = u.abilities.find((x) => x.key === 'nyx_assassin_neuro_sting');
      if (ns && t.isHeroLike) burnMana(t, ev.amount * val(ns, 'mana_burn_pct') / 100);
      const log: Map<number, { t: number; d: number }[]> = m.data.log;
      const arr = log.get(t.id) ?? [];
      arr.push({ t: u.w.time, d: ev.amount });
      if (arr.length > 60) arr.shift();
      log.set(t.id, arr);
    },
  }),
});

defineAbility({
  key: 'nyx_assassin_vendetta', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 1200 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.removeModsByName('burrowed');
    const scep = hasScepter(u);
    const free = val(a, 'free_pathing_duration');
    if (free > 0) {
      u.addMod({ name: 'vendetta_haste', duration: free, states: ST.flying | ST.noCollision, props: { msFlat: val(a, 'free_pathing_movement_speed_bonus') } }, u, a);
    }
    u.addMod({
      name: 'vendetta', duration: dur(a, 'duration'), fx: 'invis',
      states: ST.invisible | ST.noCollision,
      props: {
        msPct: val(a, 'movement_speed') / 100,
        hpRegenPct: scep ? val(a, 'health_regen_rate_scepter') / 100 : 0,
      },
      data: { breaksOnAttack: true },
      onAttackLanded(_m, ev) {
        const t = ev.target as Unit;
        if (t.team === u.team) return;
        damage(u, t, dmg(a, 'bonus_damage'), 'pure', a);
        debuff(u, t, a, { name: 'vendetta_break', duration: val(a, 'break_duration'), states: ST.broken, fx: 'break' });
        u.removeModsByName('vendetta_haste');
      },
    }, u, a);
  },
});

defineAbility({
  key: 'nyx_assassin_unburrow', target: 'none', requires: 'scepter', ai: { role: 'summon', selfRadius: 600 },
  hidden: (a) => !burrowed(a.owner as Unit),
  passive: gate((a) => burrowed(a.owner as Unit)),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.removeModsByName('burrowed');
  },
});

defineHero('nyx_assassin', ['nyx_assassin_impale', 'nyx_assassin_jolt', 'nyx_assassin_spiked_carapace', 'nyx_assassin_burrow', 'nyx_assassin_neuro_sting', 'nyx_assassin_vendetta', 'nyx_assassin_unburrow'], {
  build: ['null_talisman', 'arcane_boots', 'dagon', 'blink', 'aether_lens', 'ultimate_scepter', 'black_king_bar'],
});

