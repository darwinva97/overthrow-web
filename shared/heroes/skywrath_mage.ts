import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, silence } from './util';

/** Enemigos aleatorios alrededor de (x,y) con prioridad a héroes. */
function pickRandom(u: Unit, x: number, y: number, r: number, exclude: Set<number>, n: number): Unit[] {
  const list = u.w.enemiesIn(u.team, x, y, r).filter((e) => !exclude.has(e.id) && e.kind !== 'ward' && u.w.canSee(u.team, e));
  const out: Unit[] = [];
  for (const heroes of [true, false]) {
    const pool = list.filter((e) => e.isHeroLike === heroes);
    while (pool.length && out.length < n) out.push(pool.splice(Math.floor(u.w.rng() * pool.length), 1)[0]);
  }
  return out;
}

function bolt(u: Unit, a: AbilityInst, e: Unit) {
  u.w.addProjectile({
    kind: 'track', fx: 'arcane_bolt', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'bolt_speed'), dodgeable: false,
    onHit() {
      if (e.has(ST.magicImmune) && val(a, 'pierce_spell_immunity') <= 0) return true;
      damage(u, e, dmg(a, 'bolt_damage') + u.s.int * val(a, 'int_multiplier'), 'magical', a);
      u.w.addVision(u.team, e.x, e.y, val(a, 'bolt_vision'), val(a, 'vision_duration'));
      return true;
    },
  });
}

defineAbility({
  key: 'skywrath_mage_arcane_bolt', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  // Talento: atraviesa la inmunidad a hechizos.
  passive: (a) => { a.data.pierce = val(a, 'pierce_spell_immunity') > 0; return null; },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    bolt(u, a, e);
    // Shard: dos rayos más a enemigos cercanos al objetivo.
    const extra = val(a, 'total_bolt_count') - 1;
    if (extra > 0 && !a.temp) for (const o of pickRandom(u, e.x, e.y, val(a, 'extra_bolt_search_radius'), new Set([e.id]), extra)) bolt(u, a, o);
  },
});

defineAbility({
  key: 'skywrath_mage_concussive_shot', target: 'none', ai: { role: 'nuke', selfRadius: 1400 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const global = val(a, 'launch_global') > 0;
    const r = global ? 1e6 : val(a, 'launch_radius') + u.s.castRange;
    const e = u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true })
      .filter((x) => x.kind === 'hero' && u.w.canSee(u.team, x))
      .sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))[0];
    if (!e) return;
    u.w.addProjectile({
      kind: 'track', fx: 'concussive_shot', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'speed'), dodgeable: true,
      onHit() {
        const sr = val(a, 'slow_radius');
        u.w.addVision(u.team, e.x, e.y, val(a, 'shot_vision'), val(a, 'vision_duration'));
        u.w.emit({ n: 'aoe', x: e.x, y: e.y, r: sr, t: u.team });
        for (const v of u.w.enemiesIn(u.team, e.x, e.y, sr)) {
          damage(u, v, dmg(a, 'damage'), 'magical', a);
          debuff(u, v, a, { name: 'concussive_shot', duration: dur(a, 'slow_duration'), fx: 'slow', props: { msSlow: val(a, 'movement_speed_pct') / 100 } });
        }
        return true;
      },
    });
  },
});

defineAbility({
  key: 'skywrath_mage_ancient_seal', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    silence(u, e, dur(a, 'seal_duration'), a, 'ancient_seal');
    debuff(u, e, a, { name: 'ancient_seal_amp', duration: dur(a, 'seal_duration'), fx: 'ancient_seal', props: { magicResist: val(a, 'resist_debuff') / 100 } });
  },
});

defineAbility({
  key: 'skywrath_mage_shield_of_the_scion', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'shield_of_the_scion_passive',
    onDealDamage(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      if (ev.type !== 'magical' || !ev.ability || ev.isAttack || t.team === u.team || t.kind !== 'hero' || ev.amount <= 0) return;
      // Cada golpe añade una barrera mágica independiente.
      const sh = u.findMod('shield_of_the_scion', u) ?? u.addMod({
        name: 'shield_of_the_scion', duration: Infinity, fx: 'barrier', data: { list: [] as [number, number][] },
        onTick(mm) {
          const list = mm.data.list as [number, number][];
          const now = u.w.time;
          while (list.length && list[0][1] <= now) list.shift();
          mm.stacks = list.length;
          if (!list.length) u.removeMod(mm);
        },
        onIncomingDamage(mm, e2) {
          if (e2.type !== 'magical' || e2.hpRemoval) return;
          const list = mm.data.list as [number, number][];
          while (list.length && e2.amount > 0) {
            const take = Math.min(list[0][0], e2.amount);
            list[0][0] -= take; e2.amount -= take;
            if (list[0][0] <= 0) list.shift();
          }
          mm.stacks = list.length;
        },
      }, u, a);
      (sh.data.list as [number, number][]).push([val(a, 'damage_barrier'), u.w.time + val(a, 'barrier_duration')]);
      sh.stacks = sh.data.list.length;
    },
  }),
});

/** Campo de Mystic Flare: reparte el daño entre los héroes del área. */
function flare(u: Unit, a: AbilityInst, x: number, y: number) {
  const r = val(a, 'radius');
  const d = val(a, 'duration');
  const iv = val(a, 'damage_interval');
  const per = dmg(a, 'damage') * iv / d;
  u.w.emit({ n: 'mystic_flare', x, y, r, d, t: u.team });
  u.w.addZone({
    fx: 'mystic_flare', x, y, r, team: u.team, interval: iv, duration: d,
    onInterval(z) {
      const heroes = u.w.enemiesIn(u.team, z.x, z.y, z.r, { heroes: true });
      for (const h of heroes) damage(u, h, per / heroes.length, 'magical', a, { noProc: true });
    },
  });
}

defineAbility({
  key: 'skywrath_mage_mystic_flare', target: 'point', ult: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    flare(u, a, t.x, t.y);
    // Scepter: otro campo sobre un enemigo distinto cercano.
    if (hasScepter(u)) {
      const near = u.w.enemiesIn(u.team, t.x, t.y, val(a, 'radius'));
      const o = pickRandom(u, t.x, t.y, val(a, 'scepter_radius'), new Set(near.map((e) => e.id)), 1)[0];
      if (o) flare(u, a, o.x, o.y);
    }
  },
});

defineHero('skywrath_mage', [
  'skywrath_mage_arcane_bolt', 'skywrath_mage_concussive_shot', 'skywrath_mage_ancient_seal', 'skywrath_mage_shield_of_the_scion',
  'skywrath_mage_mystic_flare',
], {
  build: ['null_talisman', 'arcane_boots', 'rod_of_atos', 'kaya', 'force_staff', 'ultimate_scepter', 'sheepstick', 'refresher'],
});

