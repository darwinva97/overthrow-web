import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, allyTarget, optCharges } from './lib/a7';
import { castDir, debuff } from './util';

// Hueco de Shadow Poison (Release y el talento de Demonic Purge lo usan).
const POISON = 'shadow_demon_shadow_poison';

defineAbility({
  key: 'shadow_demon_disruption', target: 'unit', team: 'any', reflectable: true, ai: { role: 'disable' },
  charges: (a) => optCharges(a, 'abilitycharges', 'abilitychargerestoretime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = dur(a, 'disruption_duration');
    e.w.disjoint(e);
    if (e.cast) e.w.interruptCast(e, true);
    e.order = null; e.atk.phase = 0;
    const spec = {
      name: 'disruption', duration: d, fx: 'disruption', purgable: false,
      states: ST.hidden | ST.invulnerable | ST.untargetable | ST.noCollision,
      onDestroy(m: any) {
        const v = m.owner as Unit;
        if (!v.alive || !v.isHeroLike || !u.alive) return;
        // Al volver: dos ilusiones del desterrado bajo el control de Shadow Demon.
        for (let i = 0; i < 2; i++) {
          const ang = u.w.rng() * Math.PI * 2;
          const il = u.w.spawnIllusion(v, v.x + Math.cos(ang) * 90, v.y + Math.sin(ang) * 90, val(a, 'illusion_duration'),
            val(a, 'illusion_outgoing_damage') / 100, val(a, 'illusion_incoming_damage') / 100, u);
          il.team = u.team;
          il.owner = u;
          il.playerId = u.playerId;
          il.addMod({ name: 'disruption_illusion', persistent: true, props: { damage: val(a, 'illusion_flat_damage') } }, u, a);
          const tgt = u.w.enemiesIn(u.team, il.x, il.y, 800, { heroes: true })[0];
          if (tgt) u.w.issueOrder(il, { type: 'attack', target: tgt.id });
        }
      },
    };
    if (e.team === u.team) e.addMod(spec, u, a);
    else debuff(u, e, a, { ...spec, debuff: true });
  },
});

defineAbility({
  key: 'shadow_demon_disseminate', target: 'unit', team: 'any', reflectable: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const spec = {
      name: 'disseminate', duration: dur(a, 'duration'), fx: 'disseminate',
      onTakeDamage(m: any, ev: any) {
        const v = m.owner as Unit;
        if (ev.data?.dissem || ev.data?.reflected || ev.amount <= 0 || v.has(ST.hidden)) return;
        const amount = ev.amount * val(a, 'damage_reflection_pct') / 100;
        for (const x of u.w.enemiesIn(u.team, v.x, v.y, val(a, 'radius'))) {
          damage(u, x, amount, 'magical', a, { noProc: true, data: { dissem: true, reflected: true } });
        }
      },
    };
    if (e.team === u.team) e.addMod(spec, u, a);
    else debuff(u, e, a, spec);
  },
});

/** Daño diferido de Shadow Poison según cargas. */
function poisonDamage(a: AbilityInst, stacks: number) {
  const max = val(a, 'max_multiply_stacks');
  const base = val(a, 'stack_damage') * a.upg.dmg * Math.pow(2, Math.min(stacks, max) - 1);
  return base + Math.max(0, stacks - max) * val(a, 'bonus_stack_damage') * a.upg.dmg;
}

/** Añade una carga de Shadow Poison. */
function addPoison(u: Unit, e: Unit, a: AbilityInst) {
  const cur = e.findMod('shadow_poison', u);
  const m = debuff(u, e, a, {
    name: 'shadow_poison', duration: dur(a, 'abilityduration'), fx: 'shadow_poison', purgable: false,
    onDestroy(mm) {
      const v = mm.owner as Unit;
      if (v.alive) damage(u, v, poisonDamage(a, mm.stacks), 'magical', a);
    },
  });
  if (!m) return;
  m.stacks = (cur ? cur.stacks : 0) + 1;
  m.remaining = m.duration = dur(a, 'abilityduration');
}

defineAbility({
  key: 'shadow_demon_shadow_poison', target: 'point', ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const range = val(a, 'abilitycastrange') * a.upg.range + u.s.castRange;
    u.w.addProjectile({
      kind: 'linear', fx: 'shadow_poison', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'speed'), left: range, width: val(a, 'radius') * 2,
      onThink(p) { if (u.w.tickN % 6 === 0) u.w.addVision(u.team, p.x, p.y, val(a, 'vision_radius'), 0.3); },
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.kind === 'ward' || (v.has(ST.magicImmune) && !a.def.bkbPierce)) return;
        damage(u, v, dmg(a, 'hit_damage'), 'magical', a);
        addPoison(u, v, a);
      },
    });
  },
});

defineAbility({
  key: 'shadow_demon_shadow_poison_release', target: 'none', levelWith: 2, ai: { role: 'nuke', selfRadius: 1500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const poisoned = u.w.list.filter((x) => x.alive && x.findMod('shadow_poison', u));
    // Los bots esperan a acumular cargas antes de soltarlo.
    if (u.isBot && !poisoned.some((x) => (x.findMod('shadow_poison', u)?.stacks ?? 0) >= 3)) return;
    for (const x of poisoned) {
      const m = x.findMod('shadow_poison', u);
      if (m) x.removeMod(m);
    }
  },
});

defineAbility({
  key: 'shadow_demon_demonic_cleanse', target: 'unit', team: 'any', allowSelf: true, ai: { role: 'buff' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = allyTarget(a, t.unit as Unit);
    if (!e) return;
    e.purge(true, false);
    e.addMod({
      name: 'demonic_cleanse', duration: dur(a, 'abilityduration'), fx: 'demonic_cleanse', interval: 0.25,
      onInterval(m) { (m.owner as Unit).purge(true, false); },
      onDestroy(m) { heal(m.owner as Unit, val(a, 'purge_damage') * a.upg.dmg, u); },
    }, u, a);
  },
});

defineAbility({
  key: 'shadow_demon_demonic_purge', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  charges: (a) => optCharges(a, 'max_charges', 'charge_restore_time'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = dur(a, 'abilityduration');
    e.purge(false, true);
    const m = debuff(u, e, a, {
      name: 'demonic_purge', duration: d, fx: 'demonic_purge', purgable: false,
      // Scepter: Break mientras dura.
      states: hasScepter(u) ? ST.broken : 0,
      props: (mm) => {
        const k = mm.duration > 0 ? Math.max(0, mm.remaining) / mm.duration : 0;
        return { msSlow: (val(a, 'min_slow') + (val(a, 'max_slow') - val(a, 'min_slow')) * k) / 100 };
      },
      onTick(mm) { (mm.owner as Unit).refreshStats(); },
      onDestroy(mm) {
        const v = mm.owner as Unit;
        if (v.alive) damage(u, v, dmg(a, 'purge_damage'), 'magical', a);
      },
    });
    // Talento: también aplica una carga de Shadow Poison.
    const p = abil(u, POISON);
    if (m && val(a, 'apply_poison_stacks') > 0 && p && p.level > 0) addPoison(u, e, p);
  },
});

defineAbility({
  key: 'shadow_demon_menace', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'menace_passive',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.team === u.team || (!t.isHeroLike && t.kind !== 'creep')) return;
      const cur = t.findMod('menace', u);
      const m = debuff(u, t, a, {
        name: 'menace', duration: val(a, 'duration'), fx: 'menace',
        props: (mm) => ({ incomingPct: mm.stacks * val(a, 'stack') / 100 }),
      });
      if (!m) return;
      m.stacks = (cur?.stacks ?? 0) + 1;
      m.remaining = m.duration;
      t.refreshStats();
    },
  }),
});

defineHero('shadow_demon', [
  'shadow_demon_disruption', 'shadow_demon_disseminate', 'shadow_demon_shadow_poison', 'shadow_demon_shadow_poison_release',
  'shadow_demon_demonic_cleanse', 'shadow_demon_demonic_purge', 'shadow_demon_menace',
], {
  build: ['null_talisman', 'arcane_boots', 'force_staff', 'glimmer_cape', 'aether_lens', 'ultimate_scepter', 'sheepstick'],
});
