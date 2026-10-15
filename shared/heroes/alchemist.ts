import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { creditHero, damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, stun } from './util';
import { botOnly, enemyHeroes, LOCKED, lockSub, unlockSub } from './lib/a1';

const find = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

defineAbility({
  key: 'alchemist_acid_spray', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.addZone({
      fx: 'acid_spray', x: t.x, y: t.y, r, team: u.team, interval: val(a, 'tick_rate'), duration: dur(a, 'duration'),
      onInterval(z) {
        for (const e of u.w.enemiesIn(u.team, z.x, z.y, z.r, { immune: true })) {
          debuff(u, e, a, { name: 'acid_spray', duration: val(a, 'tick_rate') + 0.1, props: { armor: -val(a, 'armor_reduction') } });
          if (!e.has(ST.magicImmune)) damage(u, e, dmg(a, 'damage'), 'physical', a, { noProc: true });
        }
        const ally = val(a, 'armor_allies');
        if (ally > 0) for (const al of u.w.alliesIn(u.team, z.x, z.y, z.r)) {
          al.addMod({ name: 'acid_spray_ally', duration: val(a, 'tick_rate') + 0.1, props: { armor: ally } }, u, a);
        }
      },
    });
  },
});

/** Pilas de Corrosive Weaponry sobre un enemigo. */
function corrode(u: Unit, t: Unit, n: number) {
  const a = find(u.kind === 'illusion' ? (u.owner as Unit) ?? u : u, 'alchemist_corrosive_weaponry');
  if (!a || a.level <= 0 || n <= 0 || t.team === u.team) return;
  const cur = t.findMod('corrosive_weaponry', a.owner as Unit);
  const stacks = Math.min(val(a, 'max_stacks'), (cur?.stacks ?? 0) + n);
  const m = debuff(a.owner as Unit, t, a, {
    name: 'corrosive_weaponry', duration: val(a, 'debuff_duration'), stacks, fx: 'slow',
    props: (mm) => ({
      msSlow: mm.stacks * val(a, 'slow_per_stack') / 100,
      damagePct: -mm.stacks * val(a, 'attack_dmg_per_stack') / 100,
    }),
  });
  if (m) { m.stacks = stacks; m.remaining = val(a, 'debuff_duration'); t.refreshStats(); }
}

/** Explosión de Unstable Concoction en (x, y) según el tiempo de preparación. */
function explode(a: AbilityInst, x: number, y: number, brewed: number, self: Unit | null) {
  const u = a.owner as Unit;
  const k = Math.min(1, brewed / val(a, 'brew_time'));
  const throwA = find(u, 'alchemist_unstable_concoction_throw') ?? a;
  const dmgv = val(throwA, 'min_damage') + (val(throwA, 'max_damage') - val(throwA, 'min_damage')) * k;
  const st = val(throwA, 'min_stun') + (val(throwA, 'max_stun') - val(throwA, 'min_stun')) * k;
  const r = val(a, 'radius');
  u.w.emit({ n: 'nova', x, y, r, t: u.team });
  const hit = u.w.enemiesIn(u.team, x, y, r);
  if (self) hit.push(self);
  for (const e of hit) {
    damage(u, e, dmgv * a.upg.dmg, 'physical', a);
    stun(u, e, st, a);
    if (e !== self) corrode(u, e, Math.floor(brewed));
  }
}

defineAbility({
  key: 'alchemist_unstable_concoction', target: 'none', ai: { role: 'disable', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const thr = find(u, 'alchemist_unstable_concoction_throw');
    unlockSub(thr);
    const start = u.w.time;
    u.addMod({
      name: 'unstable_concoction', duration: val(a, 'brew_explosion'), fx: 'concoction', purgable: false,
      data: { start },
      props: { msPct: val(a, 'move_speed') / 100 },
      onDestroy(m) {
        lockSub(thr);
        // Si no se lanzó a tiempo explota encima de Alchemist.
        if (!m.data.thrown && u.alive) explode(a, u.x, u.y, u.w.time - start, u);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'alchemist_unstable_concoction_throw', target: 'unit', levelWith: 1, sub: true, reflectable: true,
  ai: { role: 'disable' },
  hidden: (a) => !(a.owner as Unit).findMod('unstable_concoction'),
  charges: () => LOCKED,
  passive: (a) => { if (!(a.owner as Unit).findMod('unstable_concoction')) lockSub(a); return null; },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const brew = u.findMod('unstable_concoction');
    const uc = find(u, 'alchemist_unstable_concoction');
    if (!brew || !uc) return;
    brew.data.thrown = true;
    const brewed = u.w.time - brew.data.start;
    u.removeMod(brew);
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'concoction', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'),
      onHit() { explode(uc, e.x, e.y, brewed, null); return true; },
    });
  },
});

defineAbility({
  key: 'alchemist_corrosive_weaponry', target: 'passive',
  passive: (a) => ({
    name: 'corrosive_weaponry_passive',
    onAttackLanded(_m, ev) {
      if (ev.missed) return;
      const t = ev.target as Unit;
      if (t.isHeroLike || t.kind === 'creep' || t.kind === 'summon') corrode(ev.attacker as Unit, t, val(a, 'stacks_per_attack'));
    },
  }),
});

defineAbility({
  key: 'alchemist_berserk_potion', target: 'unit', team: 'ally', allowSelf: true,
  passive: (a) => botOnly(a, (u) => (enemyHeroes(u, 700).length ? { unit: u } : null)),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const apply = () => {
      e.purge(true, false);
      e.addMod({
        name: 'berserk_potion', duration: dur(a, 'duration'), fx: 'berserk',
        props: { attackSpeed: val(a, 'attack_speed'), hpRegen: val(a, 'hp_regen'), msPct: val(a, 'move_speed') / 100 },
      }, u, a);
    };
    if (e === u) { apply(); return; }
    u.w.addProjectile({ kind: 'track', fx: 'berserk_potion', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), onHit() { apply(); return true; } });
  },
});

defineAbility({
  key: 'alchemist_goblins_greed', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => {
    const sc = hasScepter(a.owner as Unit);
    return {
      name: 'goblins_greed', stacks: 0,
      props: (m) => ({ damage: m.stacks * val(a, 'damage') + (sc ? val(a, 'scepter_bonus_damage') : 0) }),
      onTick(m) {
        const list: number[] = m.data.exp ?? [];
        const now = (m.owner as Unit).w.time;
        if (list.length && list[0] <= now) { while (list.length && list[0] <= now) list.shift(); m.stacks = list.length; (m.owner as Unit).refreshStats(); }
      },
      // Cada muerte da oro extra; cada una en los 40 s siguientes suma otra instancia.
      onAnyDeath(m, victim, killer) {
        const u = m.owner as Unit;
        if (victim.team === u.team || creditHero(killer as Unit) !== u) return;
        if (victim.kind !== 'hero' && victim.kind !== 'creep' && !victim.bountyGold) return;
        const list: number[] = (m.data.exp ??= []);
        const extra = sc ? val(a, 'bonus_gold_per_scepter') : 0;
        const gold = Math.min(val(a, 'bonus_gold_cap') + extra, val(a, 'bonus_gold') + extra + list.length * val(a, 'bonus_bonus_gold'));
        u.gold += gold;
        u.w.emit({ n: 'gold', x: victim.x, y: victim.y, v: gold, u: u.id });
        list.push(u.w.time + val(a, 'duration'));
        m.stacks = list.length;
        u.refreshStats();
      },
    };
  },
});

defineAbility({
  key: 'alchemist_chemical_rage', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.purge(true, false);
    const bat = val(a, 'base_attack_time');
    u.addMod({
      name: 'chemical_rage', duration: dur(a, 'duration'), fx: 'berserk',
      props: { hpRegen: val(a, 'bonus_health_regen'), msFlat: val(a, 'bonus_movespeed'), manaRegen: val(a, 'bonus_mana_regen') },
      // El motor no tiene una propiedad de BAT: se cambia la base de esta unidad mientras dura.
      onCreated(m) { m.data.bat = u.base.bat; u.base = { ...u.base, bat: Math.min(u.base.bat, bat) }; },
      onDestroy(m) { u.base = { ...u.base, bat: m.data.bat }; u.refreshStats(); },
    }, u, a);
  },
});

defineHero('alchemist', ['alchemist_acid_spray', 'alchemist_unstable_concoction', 'alchemist_corrosive_weaponry', 'alchemist_berserk_potion', 'alchemist_goblins_greed', 'alchemist_chemical_rage', 'alchemist_unstable_concoction_throw'], {
  build: ['bracer', 'power_treads', 'radiance', 'black_king_bar', 'basher', 'assault', 'abyssal_blade'],
});
