import { defineAbility, defineHero, dmg, dur, hasScepter, isItem, manaCostOf, val } from '../sim/abilities';
import { damage, kill } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abilityOf, addBarrier } from './lib/a0';
import { dash, debuff, slow } from './util';

/** Frostbite: raíz + desarme y daño en el tiempo (×4 a creeps). */
function frostbite(u: Unit, e: Unit, a: AbilityInst) {
  const tick = val(a, 'tick_interval');
  const mult = e.kind === 'creep' ? val(a, 'creep_multiplier') : 1;
  return debuff(u, e, a, {
    name: 'frostbite', duration: dur(a, 'duration'), states: ST.rooted | ST.disarmed, fx: 'frostbite', interval: tick,
    onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'damage_per_second') * tick * mult, 'magical', a, { noProc: true }); },
  });
}

/** Los hechizos de Crystal Maiden rompen sus propios clones. */
function shatterClones(u: Unit, x: number, y: number, r: number) {
  for (const c of u.w.list) {
    if (c.alive && c.name === 'crystal_clone' && c.owner === u && Math.hypot(c.x - x, c.y - y) <= r + c.radius) kill(c, u);
  }
}

defineAbility({
  key: 'crystal_maiden_crystal_nova', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.emit({ n: 'nova', x: t.x, y: t.y, r, t: u.team });
    u.w.addVision(u.team, t.x, t.y, r, val(a, 'vision_duration'));
    for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
      damage(u, e, dmg(a, 'nova_damage'), 'magical', a);
      slow(u, e, a, 'crystal_nova', dur(a, 'duration'), val(a, 'movespeed_slow') / 100, val(a, 'attackspeed_slow'));
    }
    shatterClones(u, t.x, t.y, r);
  },
});

defineAbility({
  key: 'crystal_maiden_frostbite', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) { frostbite(a.owner as Unit, t.unit as Unit, a); },
});

defineAbility({
  key: 'crystal_maiden_brilliance_aura', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'arcane_aura',
    props: { manaRegenAmp: val(a, 'mana_regen_amp') / 100 },
    aura: {
      radius: 0, team: 'ally', global: true,
      apply(m, t) {
        const u = m.owner as Unit;
        const near = Math.hypot(t.x - u.x, t.y - u.y) <= val(a, 'proximity_bonus_radius');
        return { name: 'arcane_aura_buff', props: { manaRegen: val(a, 'base_mana_regen') * (near ? val(a, 'proximity_bonus_factor') : 1) } };
      },
    },
  }),
});

// Shard: se desliza dejando un clon de hielo que, al romperse, congela a los enemigos cercanos.
defineAbility({
  key: 'crystal_maiden_crystal_clone', target: 'point', castBeyond: true, ai: { role: 'escape' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const ox = u.x, oy = u.y;
    let dx = t.x - u.x, dy = t.y - u.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) { dx = Math.cos(u.facing); dy = Math.sin(u.facing); } else { dx /= d; dy /= d; }
    const hop = val(a, 'hop_distance');
    u.w.disjoint(u);
    dash(u, u.x + dx * hop, u.y + dy * hop, hop / Math.max(0.05, val(a, 'hop_duration')), a, { name: 'crystal_clone_hop' });
    const clone = u.w.spawnSummon(u, {
      hp: val(a, 'clone_health'), hpRegen: 0, mana: 0, manaRegen: 0, armor: 0, mr: 0, dmgMin: 0, dmgMax: 0,
      bat: 1, attackPoint: 0, range: 0, projSpeed: 0, ms: 0, dayVision: 400, nightVision: 400, turnRate: 1, melee: true,
    }, ox, oy, val(a, 'clone_duration'), { name: 'crystal_clone' });
    clone.facing = u.facing;
    clone.addMod({
      name: 'crystal_clone', persistent: true, states: ST.disarmed | ST.rooted, fx: 'frostbite',
      onDestroy(m) {
        const c = m.owner as Unit;
        if (m.data.done) return;
        m.data.done = true;
        const fb = abilityOf(u, 'crystal_maiden_frostbite');
        const r = val(a, 'frostbite_radius');
        u.w.emit({ n: 'nova', x: c.x, y: c.y, r, t: u.team });
        if (fb && fb.level > 0 && u.alive) for (const e of u.w.enemiesIn(u.team, c.x, c.y, r)) frostbite(u, e, fb);
      },
    }, u, a);
  },
});

// Innata: parte del maná gastado en habilidades se convierte en barrera física.
defineAbility({
  key: 'crystal_maiden_glacial_guard', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'glacial_guard_passive',
    onAbilityExecuted(m, sp) {
      if (isItem(sp)) return;
      const u = m.owner as Unit;
      const spent = manaCostOf(sp as AbilityInst);
      addBarrier(u, u, a, 'glacial_guard', spent * val(a, 'mana_multiplier') / 100, val(a, 'barrier_duration'));
    },
  }),
});

/** Explosiones y ralentización del campo; vive en un modificador para que valga con y sin Scepter. */
function startField(a: AbilityInst, channel: boolean) {
  const u = a.owner as Unit;
  const total = val(a, 'abilitychanneltime');
  const n = val(a, 'num_explosions') * (1 + val(a, 'shard_bonus_explosion') / 100);
  const every = total / Math.max(1, n);
  const fbDelay = val(a, 'frostbite_delay');
  const stop = abilityOf(u, 'crystal_maiden_freezing_field_stop');
  if (stop) stop.level = 1;
  u.addMod({
    name: 'freezing_field', fx: 'freezing_field', duration: total + (channel ? 0.1 : 0),
    data: { acc: 0, q: 0, inField: {} as Record<number, number>, channel },
    // Scepter: se puede mover (más despacio), atacar y lanzar.
    props: channel ? {} : { msSlow: Math.abs(val(a, 'shard_self_movement_speed_slow_pct')) / 100 },
    aura: {
      radius: val(a, 'radius'), team: 'enemy',
      apply: () => ({ name: 'freezing_field_slow', debuff: true, fx: 'slow', duration: val(a, 'slow_duration'), props: {
        msSlow: Math.abs(val(a, 'movespeed_slow')) / 100, attackSlow: Math.abs(val(a, 'attack_slow')) } }),
    },
    onTick(m, dt) {
      // Con Scepter lo siguen interrumpiendo los enemigos.
      if (!m.data.channel && (u.has(ST.stunned) || u.has(ST.silenced) || u.has(ST.hexed))) { u.removeMod(m); return; }
      m.data.acc += dt;
      while (m.data.acc >= every) {
        m.data.acc -= every;
        // Las explosiones recorren los cuatro cuadrantes por turnos, como en Dota.
        const q = m.data.q++ % 4;
        const ang = (q + u.w.rng()) * Math.PI / 2;
        const dist = val(a, 'explosion_min_dist') + u.w.rng() * (val(a, 'explosion_max_dist') - val(a, 'explosion_min_dist'));
        const x = u.x + Math.cos(ang) * dist, y = u.y + Math.sin(ang) * dist;
        const r = val(a, 'explosion_radius');
        u.w.emit({ n: 'frost_explosion', x, y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, x, y, r)) damage(u, e, dmg(a, 'damage'), 'magical', a);
        shatterClones(u, x, y, r);
      }
      // Scepter: Frostbite a quien lleve un rato dentro del campo.
      if (fbDelay > 0) {
        const fb = abilityOf(u, 'crystal_maiden_frostbite');
        const inside = new Set<number>();
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) {
          inside.add(e.id);
          const tt = (m.data.inField[e.id] ?? 0) + dt;
          m.data.inField[e.id] = tt;
          if (tt >= fbDelay && tt - dt < fbDelay && fb && fb.level > 0) frostbite(u, e, fb);
        }
        for (const id of Object.keys(m.data.inField)) if (!inside.has(+id)) delete m.data.inField[+id];
      }
    },
    onDestroy() { if (stop) stop.level = 0; },
  }, u, a);
}

defineAbility({
  key: 'crystal_maiden_freezing_field', target: 'none', ult: true, ai: { role: 'channel', selfRadius: 600 },
  channel: (a) => (hasScepter(a.owner as Unit) ? 0 : val(a, 'abilitychanneltime')),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.removeModsByName('freezing_field');
    startField(a, !hasScepter(u));
  },
  onChannelEnd(a) { (a.owner as Unit).removeModsByName('freezing_field'); },
});

// Sub-habilidad: solo tiene nivel mientras dura el campo.
defineAbility({
  key: 'crystal_maiden_freezing_field_stop', target: 'none', sub: true, hidden: (a) => a.level <= 0,
  // Con Scepter: lo corta para perseguir a un objetivo casi muerto a velocidad normal.
  ai: { role: 'buff', hpBelow: 0.15 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const ff = abilityOf(u, 'crystal_maiden_freezing_field');
    if (u.cast && ff && u.cast.a === ff) u.w.interruptCast(u, false);
    u.removeModsByName('freezing_field');
  },
});

defineHero('crystal_maiden', [
  'crystal_maiden_crystal_nova', 'crystal_maiden_frostbite', 'crystal_maiden_brilliance_aura', 'crystal_maiden_crystal_clone',
  'crystal_maiden_glacial_guard', 'crystal_maiden_freezing_field', 'crystal_maiden_freezing_field_stop',
], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'black_king_bar', 'sheepstick', 'refresher'],
});
