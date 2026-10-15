import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, refreshPassive, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abilityOf, realHero } from './lib/a0';
import { illusionsOf, slow } from './util';

/** Crea una ilusión de PL que ataca a `target`. Illusory Armaments le pone un suelo de daño. */
function lancerIllusion(u: Unit, x: number, y: number, duration: number, out: number, inc: number, target?: Unit) {
  const hero = realHero(u);
  const il = u.w.spawnIllusion(hero, x, y, duration, out / 100, inc / 100);
  const arm = abilityOf(hero, 'phantom_lancer_illusory_armaments');
  if (arm) {
    const floor = val(arm, 'outgoing_floor') / 100 - 1;
    if (out / 100 < floor) {
      il.addMod({ name: 'illusory_armaments', duration: val(arm, 'duration'), props: { outgoingPct: floor - out / 100 } }, hero, arm);
    }
  }
  // Juxtapose tiene activa con Shard; el motor solo copia a ilusiones las pasivas puras.
  const jx = il.abilities.find((x) => x.key === 'phantom_lancer_juxtapose');
  if (jx && !jx.passiveMod) refreshPassive(jx);
  if (target) u.w.issueOrder(il, { type: 'attack', target: target.id });
  return il;
}

/** Ilusión de Juxtapose (la usan la ulti, el Scepter de Phantom Rush y el Shard). */
function juxtaIllusion(u: Unit, x: number, y: number, target?: Unit) {
  const hero = realHero(u);
  const jx = abilityOf(hero, 'phantom_lancer_juxtapose');
  if (!jx || jx.level <= 0) return null;
  const d = u.kind === 'illusion' ? val(jx, 'illusion_from_illusion_duration') : val(jx, 'illusion_duration');
  return lancerIllusion(u, x, y, d, val(jx, 'illusion_damage_out_pct'), val(jx, 'illusion_damage_in_pct'), target);
}

function lance(a: AbilityInst, from: Unit, e: Unit, pct: number, spawn: boolean) {
  const u = a.owner as Unit;
  u.w.addProjectile({
    kind: 'track', fx: 'spirit_lance', source: from, target: e, x: from.x, y: from.y,
    speed: val(a, 'lance_speed'), dodgeable: true,
    onHit() {
      if (e.has(ST.magicImmune)) return true;
      damage(u, e, dmg(a, 'lance_damage') * pct, 'magical', a);
      slow(u, e, a, 'spirit_lance', dur(a, 'duration'), val(a, 'movement_speed_pct') / 100);
      if (spawn && u.team !== e.team && !a.temp && e.alive) {
        const ang = u.w.rng() * Math.PI * 2;
        lancerIllusion(u, e.x + Math.cos(ang) * 120, e.y + Math.sin(ang) * 120, val(a, 'illusion_duration'),
          val(a, 'illusion_damage_out_pct'), val(a, 'illusion_damage_in_pct'), e);
      }
      return true;
    },
  });
}

defineAbility({
  key: 'phantom_lancer_spirit_lance', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    lance(a, u, e, 1, true);
    // Talento: las ilusiones cercanas también lanzan la suya, con parte del daño.
    const pct = val(a, 'illusion_lance_damage_pct') / 100;
    if (pct > 0 && !a.temp) {
      for (const il of illusionsOf(u)) {
        if (Math.hypot(il.x - e.x, il.y - e.y) <= val(a, 'fake_lance_distance')) lance(a, il, e, pct, false);
      }
    }
  },
});

defineAbility({
  key: 'phantom_lancer_doppelwalk', target: 'point', ai: { role: 'escape' },
  aoe: (a) => val(a, 'target_aoe'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const delay = val(a, 'delay');
    const aoe = val(a, 'target_aoe');
    const group = [u, ...illusionsOf(u).filter((i) => Math.hypot(i.x - u.x, i.y - u.y) <= val(a, 'search_radius'))];
    u.purge(true, false);
    for (const g of group) {
      g.w.disjoint(g);
      g.addMod({ name: 'doppelwalk', duration: delay, states: ST.hidden | ST.invulnerable | ST.untargetable, fx: 'doppel' }, u, a);
      g.order = null; g.atk.phase = 0;
      u.w.emit({ n: 'blink', x: g.x, y: g.y, u: g.id, c: 'pl' });
      // Alarga la duración de las ilusiones que se llevan.
      if (g !== u) g.expireAt += val(a, 'illusion_extended_duration');
    }
    u.w.after(delay, () => {
      const spots = () => {
        const ang = u.w.rng() * Math.PI * 2, r = Math.sqrt(u.w.rng()) * aoe;
        return [t.x + Math.cos(ang) * r, t.y + Math.sin(ang) * r];
      };
      for (const g of group) if (g.alive) { const [x, y] = spots(); u.w.teleport(g, x, y); }
      if (!u.alive) return;
      const d = val(a, 'illusion_duration');
      let [x, y] = spots();
      lancerIllusion(u, x, y, d, val(a, 'illusion_1_damage_out_pct'), val(a, 'illusion_1_damage_in_pct'));
      for (let i = 0; i < val(a, 'illusion_2_amount'); i++) {
        [x, y] = spots();
        lancerIllusion(u, x, y, d, val(a, 'illusion_2_damage_out_pct'), val(a, 'illusion_2_damage_in_pct'));
      }
    });
  },
});

defineAbility({
  key: 'phantom_lancer_phantom_edge', target: 'passive',
  passive: (a) => ({
    name: 'phantom_rush_watch',
    onTick(m) {
      const u = m.owner as Unit;
      if (a.cd > 0 || u.findMod('phantom_rush') || u.has(ST.rooted)) return;
      const o = u.order;
      if (!o || o.type !== 'attack') return;
      const t = u.w.units.get(o.target);
      if (!t || t.team === u.team) return;
      const d = Math.hypot(t.x - u.x, t.y - u.y);
      if (d < val(a, 'min_distance') || d > val(a, 'max_distance')) return;
      a.cd = cooldownOf(a);
      const sx = u.x, sy = u.y;
      const passed = new Set<number>();
      u.addMod({
        name: 'phantom_rush', duration: 2, fx: 'phantom_rush',
        props: { msFlat: val(a, 'bonus_speed'), evasion: val(a, 'evasion') / 100 },
        data: { spawned: 0 },
        onTick(mm) {
          const tt = u.w.units.get(o.target);
          // Scepter: ilusiones al atravesar enemigos y cada cierta distancia recorrida.
          if (hasScepter(u) && u.kind === 'hero') {
            const r = val(a, 'illusion_spawn_radius');
            for (const e of u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true })) {
              if (passed.has(e.id) || e === tt) continue;
              passed.add(e.id);
              juxtaIllusion(u, e.x + 60, e.y, e);
            }
            const every = val(a, 'illusion_spawn_travel_distance');
            const run = Math.hypot(u.x - sx, u.y - sy);
            if (every > 0 && run >= every * (mm.data.spawned + 1)) {
              mm.data.spawned++;
              juxtaIllusion(u, u.x, u.y, tt);
            }
          }
          if (!tt || Math.hypot(tt.x - u.x, tt.y - u.y) <= u.s.attackRange + 60) {
            mm.remaining = Math.min(mm.remaining, 0.01);
            u.addMod({ name: 'phantom_rush_evasion', duration: 2, props: { evasion: val(a, 'evasion') / 100 } }, u, a);
          }
        },
      }, u, a);
    },
  }),
});

defineAbility({
  key: 'phantom_lancer_illusory_armaments', target: 'passive', innate: true,
});

defineAbility({
  key: 'phantom_lancer_juxtapose', target: 'none', ult: true,
  // Sin Shard es solo pasiva: sin cargas no se puede lanzar. Con Shard, una carga = su enfriamiento.
  charges: (a) => (hasShard(a.owner as Unit) ? [1, val(a, '_cd')] : [0, 0]),
  ai: { role: 'escape', selfRadius: 250 },
  passive: (a) => ({
    name: 'juxtapose',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (ev.fake || !t.isHeroLike && t.kind !== 'creep') return;
      const hero = realHero(u);
      if (!hero || illusionsOf(hero).length >= val(a, 'max_illusions')) return;
      const chance = u.kind === 'illusion' ? val(a, 'illusion_proc_chance_pct') : val(a, 'proc_chance_pct');
      if (u.w.rng() >= chance / 100) return;
      const ang = u.w.rng() * Math.PI * 2;
      juxtaIllusion(u, u.x + Math.cos(ang) * 80, u.y + Math.sin(ang) * 80, t);
    },
  }),
  // Shard: invisibilidad con velocidad extra y una ilusión que sigue andando para despistar.
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (!hasShard(u)) return;
    const il = juxtaIllusion(u, u.x, u.y);
    if (il) u.w.issueOrder(il, { type: 'move', x: u.x + Math.cos(u.facing) * 900, y: u.y + Math.sin(u.facing) * 900 });
    u.addMod({
      name: 'juxtapose_invis', duration: val(a, 'invis_duration'), fx: 'invis', states: ST.invisible | ST.noCollision,
      props: { msPct: val(a, 'invis_movespeed') / 100 }, data: { breaksOnAttack: true },
    }, u, a);
  },
});

defineHero('phantom_lancer', [
  'phantom_lancer_spirit_lance', 'phantom_lancer_doppelwalk', 'phantom_lancer_phantom_edge',
  'phantom_lancer_illusory_armaments', 'phantom_lancer_juxtapose',
], {
  build: ['wraith_band', 'power_treads', 'diffusal_blade', 'manta', 'heart', 'skadi', 'butterfly'],
});
