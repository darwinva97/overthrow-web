import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abilityOf } from './lib/a0';
import { debuff } from './util';

/** Battle Hunger: daño puro en el tiempo hasta que el objetivo mate algo; ralentiza si da la espalda a Axe. */
function battleHunger(u: Unit, e: Unit, a: AbilityInst) {
  // Shard: varias instancias se acumulan en el mismo objetivo.
  const multi = hasShard(u) && val(a, 'should_stack') > 0;
  const m = debuff(u, e, a, {
    name: 'battle_hunger', duration: dur(a, 'duration'), fx: 'battle_hunger', interval: 1,
    data: { multi },
    props: (mm) => (mm.data.away ? { msSlow: val(a, 'slow') / 100 } : {}),
    onCreated() { a.data.active = (a.data.active ?? 0) + 1; u.refreshStats(); },
    onDestroy() { a.data.active = Math.max(0, (a.data.active ?? 0) - 1); u.refreshStats(); },
    onInterval(mm) { damage(u, mm.owner as Unit, dmg(a, 'damage_per_second'), 'pure', a, { noProc: true }); },
    onTick(mm) {
      const v = mm.owner as Unit;
      const toAxe = Math.atan2(u.y - v.y, u.x - v.x);
      let diff = Math.abs(toAxe - v.facing) % (Math.PI * 2);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      const away = diff > Math.PI / 2;
      if (away !== !!mm.data.away) { mm.data.away = away; v.refreshStats(); }
    },
    onKill(mm) { (mm.owner as Unit).removeMod(mm); },
  });
  return m;
}

defineAbility({
  key: 'axe_berserkers_call', target: 'none', ai: { role: 'disable', selfRadius: 300 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = dur(a, 'duration');
    const bh = abilityOf(u, 'axe_battle_hunger');
    u.w.emit({ n: 'berserkers_call', x: u.x, y: u.y, r: val(a, 'radius'), u: u.id, t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) {
      const m = debuff(u, e, a, { name: 'taunt', duration: d, states: ST.taunted, fx: 'taunt' });
      if (m && e.cast) e.w.interruptCast(e, true);
      // Shard: aplica Battle Hunger a los provocados.
      if (m && val(a, 'applies_battle_hunger') > 0 && bh && bh.level > 0) battleHunger(u, e, bh);
    }
    u.addMod({
      name: 'berserkers_call_armor', duration: d, fx: 'berserkers_call',
      props: { armor: val(a, 'bonus_armor'), attackSpeed: val(a, 'bonus_attack_speed') },
    }, u, a);
  },
});

defineAbility({
  key: 'axe_battle_hunger', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  // Talento: Axe gana velocidad por cada Battle Hunger activo.
  passive: (a) => ({
    name: 'battle_hunger_speed',
    props: () => ({ msPct: (a.data.active ?? 0) * val(a, 'speed_bonus') / 100 }),
  }),
  onSpellStart(a, t) { battleHunger(a.owner as Unit, t.unit as Unit, a); },
});

defineAbility({
  key: 'axe_counter_helix', target: 'passive',
  passive: (a) => ({
    name: 'counter_helix', data: { count: 0, readyAt: 0 },
    onAttacked(m, ev) {
      const u = m.owner as Unit;
      if (ev.attacker.team === u.team) return;
      advanceHelix(a, m, u);
    },
    // Scepter: los ataques de Axe también hacen avanzar el contador.
    onAttackLanded(m) {
      const u = m.owner as Unit;
      if (val(a, 'attacks_increase_counter') > 0) advanceHelix(a, m, u);
    },
    // Scepter: los debilitados por la hélice le hacen menos daño de ataque.
    onIncomingDamage(_m, ev) {
      if (!ev.isAttack || !ev.source) return;
      const w = (ev.source as Unit).findMod('helix_weaken', ev.target);
      if (w) ev.amount *= Math.max(0, 1 - w.stacks * val(a, 'damage_reduction') / 100);
    },
  }),
});

function advanceHelix(a: AbilityInst, m: { data: Record<string, any>; stacks: number }, u: Unit) {
  if (u.kind === 'illusion') return;
  m.data.count++;
  m.stacks = m.data.count;
  if (m.data.count < val(a, 'trigger_attacks') || u.w.time < m.data.readyAt) return;
  m.data.count = 0; m.stacks = 0;
  m.data.readyAt = u.w.time + val(a, '_cd');
  u.w.emit({ n: 'helix', x: u.x, y: u.y, r: val(a, 'radius'), u: u.id });
  const ls = val(a, 'helix_lifesteal') / 100;
  const scepter = hasScepter(u) && val(a, 'debuff_duration') > 0;
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) {
    const dealt = damage(u, e, dmg(a, 'damage'), 'pure', a);
    if (ls > 0 && e.isHeroLike) heal(u, dealt * ls, u, true);
    if (scepter && e.alive) {
      const old = e.findMod('helix_weaken', u);
      const stacks = Math.min(val(a, 'max_stacks'), (old?.stacks ?? 0) + 1);
      const w = debuff(u, e, a, { name: 'helix_weaken', duration: val(a, 'debuff_duration'), stacks, fx: 'slow' });
      if (w) w.stacks = stacks;
    }
  }
}

defineAbility({
  key: 'axe_culling_blade', target: 'unit', ult: true, ai: { role: 'nuke', hpBelow: 0.35 },
  passive: (a) => ({
    name: 'culling_blade_stacks', stacks: a.data.stacks ?? 0,
    props: () => ({ armor: (a.data.stacks ?? 0) * val(a, 'armor_per_stack') }),
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const thr = dmg(a, 'damage');
    if (e.hp <= thr) {
      u.w.emit({ n: 'culling_blade', x: e.x, y: e.y, u: e.id, c: 'kill' });
      damage(u, e, e.hp + 1, 'pure', a, { hpRemoval: true });
      if (!e.alive && e.kind === 'hero') {
        a.cd = 0;
        a.data.stacks = (a.data.stacks ?? 0) + 1;
        if (a.passiveMod) a.passiveMod.stacks = a.data.stacks;
        for (const al of u.w.alliesIn(u.team, u.x, u.y, val(a, 'speed_aoe'), { heroes: true })) {
          al.addMod({ name: 'culling_blade_boost', duration: val(a, 'speed_duration'), fx: 'haste',
            props: { msPct: val(a, 'speed_bonus') / 100, armor: val(a, 'armor_bonus') } }, u, a);
        }
        u.refreshStats();
      }
    } else {
      u.w.emit({ n: 'culling_blade', x: e.x, y: e.y, u: e.id });
      damage(u, e, thr, 'pure', a);
    }
  },
});

// Innata: fuerza extra según su armadura mientras no haya héroes aliados cerca.
defineAbility({
  key: 'axe_one_man_army', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'one_man_army', interval: 0.25, data: { bonus: 0, lastAlone: -99 },
    props: (m) => ({ str: m.data.bonus }),
    onInterval(m) {
      const u = m.owner as Unit;
      const allies = u.w.alliesIn(u.team, u.x, u.y, val(a, 'radius'), { heroes: true }).filter((x) => x !== u && x.kind === 'hero');
      let bonus = m.data.bonus;
      if (!allies.length) {
        m.data.lastAlone = u.w.time;
        bonus = Math.max(0, u.s.armor) * val(a, 'armor_pct_as_strength') / 100;
      } else if (u.w.time - m.data.lastAlone >= val(a, 'bonus_linger_duration')) bonus = 0;
      if (Math.abs(bonus - m.data.bonus) >= 0.5 || (bonus === 0 && m.data.bonus !== 0)) {
        m.data.bonus = Math.round(bonus);
        u.refreshStats();
      }
    },
  }),
});

defineHero('axe', ['axe_berserkers_call', 'axe_battle_hunger', 'axe_counter_helix', 'axe_culling_blade', 'axe_one_man_army'], {
  build: ['bracer', 'phase_boots', 'blink', 'blade_mail', 'black_king_bar', 'heart', 'assault'],
});
