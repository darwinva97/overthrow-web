import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { expire, fear, gate, heroOf, refund } from './lib/a8';
import { illusionsOf, slow } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

defineAbility({
  key: 'terrorblade_reflection', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'range'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const d = dur(a, 'illusion_duration');
    w.emit({ n: 'reflection', x: t.x, y: t.y, r: val(a, 'range'), t: u.team });
    for (const e of w.enemiesIn(u.team, t.x, t.y, val(a, 'range'), { heroes: true })) {
      if (!slow(u, e, a, 'reflection_slow', d, val(a, 'move_slow') / 100, val(a, 'attack_slow'))) continue;
      // Reflejo invulnerable del enemigo, del equipo de TB, que solo le ataca a él.
      const ang = w.rng() * Math.PI * 2;
      const il = w.spawnIllusion(e, e.x + Math.cos(ang) * 100, e.y + Math.sin(ang) * 100, d, val(a, 'illusion_outgoing_damage') / 100, 0, u);
      il.team = u.team;
      il.playerId = null;
      il.addMod({
        name: 'reflection', persistent: true, fx: 'reflection', states: ST.invulnerable | ST.untargetable | ST.noCollision,
        onTick() {
          if (!e.alive) { expire(il); return; }
          const o = il.order;
          if (!o || o.type !== 'attack' || o.target !== e.id) w.issueOrder(il, { type: 'attack', target: e.id });
        },
      }, u, a);
      w.issueOrder(il, { type: 'attack', target: e.id });
    }
  },
});

defineAbility({
  key: 'terrorblade_conjure_image', target: 'none', ai: { role: 'buff', selfRadius: 800 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const ang = w.rng() * Math.PI * 2;
    const il = w.spawnIllusion(u, u.x + Math.cos(ang) * 80, u.y + Math.sin(ang) * 80, dur(a, 'illusion_duration'),
      val(a, 'illusion_outgoing_damage') / 100, val(a, 'illusion_incoming_damage') / 100);
    const meta = u.findMod('metamorphosis', u);
    if (meta) il.addMod(metaSpec(meta.ability as AbilityInst, meta.remaining), u, meta.ability);
    const tgt = u.order?.type === 'attack' ? u.order.target : u.atk.target;
    if (tgt && w.units.get(tgt)?.team !== u.team) w.issueOrder(il, { type: 'attack', target: tgt });
    else w.issueOrder(il, { type: 'attackMove', x: u.x + Math.cos(u.facing) * 400, y: u.y + Math.sin(u.facing) * 400 });
  },
});

/**
 * Metamorfosis: ataque a distancia con BAT propio. La base de stats es compartida entre TB
 * y sus ilusiones, así que solo el héroe la cambia y la restaura.
 */
function metaSpec(a: AbilityInst, duration: number) {
  return {
    name: 'metamorphosis', duration, fx: 'metamorphosis',
    props: { damage: dmg(a, 'bonus_damage') },
    onCreated(m: any) {
      const v = m.owner as Unit;
      v.removeModsByName('demon_zeal');
      if (v.kind !== 'hero' || v.data_meta) return;
      const b = v.base;
      v.data_meta = { melee: b.melee, range: b.range, bat: b.bat };
      b.melee = false;
      b.range = v.data_meta.range + val(a, 'bonus_range');
      b.bat = val(a, 'base_attack_time');
    },
    onDestroy(m: any) {
      const v = m.owner as Unit;
      if (v.kind !== 'hero' || !v.data_meta) return;
      Object.assign(v.base, v.data_meta);
      v.data_meta = null;
    },
  };
}

function metamorph(u: Unit, a: AbilityInst, duration: number) {
  u.addMod(metaSpec(a, duration), u, a);
  for (const il of illusionsOf(u)) {
    if (il.findMod('reflection') || Math.hypot(il.x - u.x, il.y - u.y) > val(a, 'metamorph_aura_tooltip')) continue;
    il.addMod(metaSpec(a, duration), u, a);
  }
  u.w.emit({ n: 'metamorphosis', x: u.x, y: u.y, u: u.id });
}

defineAbility({
  key: 'terrorblade_metamorphosis', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) { metamorph(a.owner as Unit, a, dur(a, 'duration')); },
});

defineAbility({
  key: 'terrorblade_demon_zeal', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  passive: (a) => ({ name: 'demon_zeal_gate', onTick() { gate(a, !(a.owner as Unit).findMod('metamorphosis')); } }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    damage(u, u, u.hp * val(a, 'health_cost_pct') / 100, 'pure', a, { hpRemoval: true, noProc: true, data: { nonLethal: true } });
    const spec = {
      name: 'demon_zeal', duration: val(a, 'duration'), fx: 'demon_zeal',
      props: { attackSpeed: val(a, 'berserk_bonus_attack_speed'), msFlat: val(a, 'berserk_bonus_movement_speed'), hpRegen: val(a, 'hp_regen') },
    };
    u.addMod(spec, u, a);
    for (const il of illusionsOf(u)) {
      if (il.findMod('reflection') || Math.hypot(il.x - u.x, il.y - u.y) > val(a, 'radius')) continue;
      il.addMod(spec, u, a);
    }
  },
});

defineAbility({
  key: 'terrorblade_terror_wave', target: 'none', ai: { role: 'aoe', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const cx = u.x, cy = u.y;
    const R = val(a, 'scepter_radius');
    const hit = new Set<number>();
    w.after(val(a, 'scepter_spawn_delay'), () => {
      w.emit({ n: 'terror_wave', x: cx, y: cy, r: R, d: R / val(a, 'scepter_speed'), t: u.team });
      let r = 0;
      w.addZone({
        fx: '', x: cx, y: cy, r: 0, team: u.team, interval: 0.05, duration: R / val(a, 'scepter_speed') + 0.1,
        onInterval() {
          r = Math.min(R, r + val(a, 'scepter_speed') * 0.05);
          for (const e of w.enemiesIn(u.team, cx, cy, r, { heroes: true })) {
            if (hit.has(e.id)) continue;
            hit.add(e.id);
            damage(u, e, dmg(a, 'damage'), 'magical', a);
            fear(u, e, a, val(a, 'fear_duration'), cx, cy, 'terror_wave_fear');
          }
        },
      });
      const meta = ability(u, 'terrorblade_metamorphosis');
      if (meta && u.alive) metamorph(u, meta, val(a, 'scepter_meta_duration'));
    });
  },
});

defineAbility({
  key: 'terrorblade_sunder', target: 'unit', team: 'any', ult: true, reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e.isHeroLike) return;
    const pu = u.hp / u.s.maxHp, pe = e.hp / e.s.maxHp;
    // Los bots solo intercambian si salen ganando.
    if (u.isBot && pu >= pe) { refund(a); return; }
    const min = val(a, 'hit_point_minimum_pct') / 100;
    const minE = e.team !== u.team && val(a, 'ignore_minimum_pct_for_enemies') > 0 ? 0.01 : min;
    u.hp = Math.max(1, Math.max(pe, min) * u.s.maxHp);
    e.hp = Math.max(1, Math.max(pu, minE) * e.s.maxHp);
    u.w.emit({ n: 'sunder', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
  },
});

defineAbility({
  key: 'terrorblade_dark_unity', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'dark_unity', interval: 0.25,
    onInterval(m) {
      const u = heroOf(m.owner as Unit);
      for (const il of illusionsOf(u)) {
        const inside = Math.hypot(il.x - u.x, il.y - u.y) <= val(a, 'radius');
        const pct = (inside ? val(a, 'inside_radius_bonus_damage_pct') : val(a, 'outside_radius_bonus_damage_pct')) / 100;
        if (pct > 0) il.addMod({ name: 'dark_unity_bonus', duration: 0.35, props: { damagePct: pct } }, u, a);
      }
    },
  }),
});

defineHero('terrorblade', ['terrorblade_reflection', 'terrorblade_conjure_image', 'terrorblade_metamorphosis', 'terrorblade_demon_zeal',
  'terrorblade_terror_wave', 'terrorblade_sunder', 'terrorblade_dark_unity'], {
  build: ['wraith_band', 'power_treads', 'yasha', 'manta', 'skadi', 'black_king_bar', 'butterfly', 'satanic'],
});
