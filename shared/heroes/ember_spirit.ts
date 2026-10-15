import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, manaCostOf, val } from '../sim/abilities';
import { damage, launchAttack } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { dash, root } from './util';
import { botCast, foes, nearestEnemyHero, summonsOf } from './lib/a3';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key && x.level > 0);
const remnants = (u: Unit) => summonsOf(u, 'ember_spirit_remnant');

defineAbility({
  key: 'ember_spirit_searing_chains', target: 'none', ai: { role: 'disable', selfRadius: 350 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    chains(u, a, u.x, u.y);
  },
});

/** Encadena hasta `unit_count` enemigos al azar (héroes primero) alrededor de un punto. */
function chains(u: Unit, a: AbilityInst, x: number, y: number) {
  const list = foes(u, x, y, val(a, 'radius'), a).filter((e) => e.kind !== 'ward');
  list.sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || u.w.rng() - 0.5);
  const d = dur(a, 'duration');
  const tick = val(a, 'tick_interval');
  u.w.emit({ n: 'searing_chains', x, y, r: val(a, 'radius'), t: u.team });
  for (const e of list.slice(0, val(a, 'unit_count'))) {
    const m = root(u, e, d, a, 'searing_chains');
    if (!m) continue;
    m.interval = tick;
    m.fx = 'searing_chains';
    m.onInterval = (mm) => { damage(u, mm.owner as Unit, dmg(a, 'damage_per_second') * tick, 'magical', a, { noProc: true }); };
  }
}

defineAbility({
  key: 'ember_spirit_sleight_of_fist', target: 'point', ai: { role: 'nuke' }, castBeyond: false,
  aoe: (a) => val(a, 'radius'),
  // Con el talento de cargas funciona por cargas; si no, una carga con el enfriamiento normal.
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), val(a, 'abilitychargerestoretime')],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const targets = foes(u, t.x, t.y, r, a).filter((e) => e.kind !== 'ward' && u.w.canSee(u.team, e));
    if (!targets.length) return;
    const sx = u.x, sy = u.y;
    const bonus = dmg(a, 'bonus_hero_damage');
    u.w.emit({ n: 'sleight_of_fist', x: t.x, y: t.y, r, t: u.team });
    u.w.emit({ n: 'blink', x: sx, y: sy, u: u.id, c: 'ember' });
    u.w.disjoint(u);
    if (u.cast) u.w.interruptCast(u, true);
    u.order = null;
    let i = 0;
    const strike = () => {
      while (i < targets.length && (!targets[i].alive || !u.w.targetable(targets[i]))) i++;
      if (i >= targets.length) return false;
      const e = targets[i++];
      const ang = u.w.rng() * Math.PI * 2;
      u.w.forceMove(u, e.x + Math.cos(ang) * 50, e.y + Math.sin(ang) * 50);
      u.facing = Math.atan2(e.y - u.y, e.x - u.x);
      launchAttack(u, e, true);
      return true;
    };
    const mod = u.addMod({
      name: 'sleight_of_fist', duration: targets.length * val(a, 'attack_interval') + 0.1, fx: 'sleight_of_fist',
      states: ST.invulnerable | ST.untargetable | ST.busy | ST.noCollision,
      onAttackStart(_m, ev) { if (ev.target.isHeroLike) ev.damage += bonus; },
      onTick(m, dt) {
        m.acc = (m.acc ?? 0) + dt;
        while (m.acc >= val(a, 'attack_interval')) {
          m.acc -= val(a, 'attack_interval');
          if (!strike()) { m.remaining = 0.001; return; }
        }
      },
      onDestroy() {
        if (!u.alive) return;
        u.w.forceMove(u, sx, sy);
        u.w.emit({ n: 'blink', x: sx, y: sy, u: u.id, c: 'ember' });
      },
    }, u, a);
    if (!strike()) u.removeMod(mod);
  },
});

defineAbility({
  key: 'ember_spirit_flame_guard', target: 'none', ai: { role: 'buff', selfRadius: 450 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.purge(true, false);
    const tick = val(a, 'tick_interval');
    u.addMod({
      name: 'flame_guard', duration: dur(a, 'duration'), fx: 'flame_guard', interval: tick, purgable: true,
      data: { left: val(a, 'absorb_amount') * a.upg.dmg },
      onIncomingDamage(m, ev) {
        if (ev.type !== 'magical' || ev.hpRemoval) return;
        const take = Math.min(m.data.left, ev.amount * val(a, 'shield_pct_absorb') / 100);
        m.data.left -= take;
        ev.amount -= take;
        if (m.data.left <= 0) m.remaining = 0.001;
      },
      onInterval() {
        for (const e of foes(u, u.x, u.y, val(a, 'radius'), a)) {
          damage(u, e, dmg(a, 'damage_per_second') * tick, 'magical', a, { noProc: true });
        }
      },
    }, u, a);
  },
});

/** Recorre los remanentes (el más cercano al punto, al final) explotándolos. */
defineAbility({
  key: 'ember_spirit_activate_fire_remnant', target: 'point', castBeyond: true, levelWith: 5,
  castRange: () => 99999,
  // Bot: salta cuando algún remanente quieto tiene un héroe enemigo al lado.
  passive: (a) => botCast(a, (u) => {
    if (u.findMod('fire_remnant_travel')) return null;
    const ready = remnants(u).filter((r) => r.data_arrived);
    const radius = val(a, 'radius');
    for (const r of ready) {
      const e = nearestEnemyHero(r, radius);
      if (e) return { x: r.x, y: r.y };
    }
    if (u.hp / u.s.maxHp < 0.25 && ready.length) {
      const f = u.w.teams[u.team]?.fountain;
      if (f) return f;
    }
    return null;
  }, 0.3),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const list = remnants(u);
    if (!list.length || u.findMod('fire_remnant_travel')) {
      u.mana += manaCostOf(a);
      return;
    }
    // Con Scepter cuesta menos maná.
    if (hasScepter(u)) u.mana = Math.min(u.s.maxMana, u.mana + Math.max(0, manaCostOf(a) - val(a, 'scepter_mana_cost')));
    list.sort((p, q) => Math.hypot(q.x - t.x, q.y - t.y) - Math.hypot(p.x - t.x, p.y - t.y));
    const last = list.pop()!;
    // Visita primero los demás, del más cercano a Ember al más lejano, y acaba en el elegido.
    const order: Unit[] = [];
    let px = u.x, py = u.y;
    const rest = [...list];
    while (rest.length) {
      rest.sort((p, q) => Math.hypot(p.x - px, p.y - py) - Math.hypot(q.x - px, q.y - py));
      const n = rest.shift()!;
      order.push(n);
      px = n.x; py = n.y;
    }
    order.push(last);
    const ult = ab(u, 'ember_spirit_fire_remnant') ?? a;
    const travel = u.addMod({
      name: 'fire_remnant_travel', duration: 30, fx: 'fire_remnant',
      states: ST.invulnerable | ST.untargetable | ST.busy | ST.noCollision | ST.rooted,
    }, u, a);
    u.w.disjoint(u);
    if (u.cast) u.w.interruptCast(u, true);
    const hop = () => {
      const r = order.shift();
      if (!r || !u.alive) { u.removeMod(travel); return; }
      dash(u, r.x, r.y, val(a, 'speed'), a, {
        name: 'fire_remnant_dash', maxTime: 10,
        onArrive: () => {
          explode(u, ult, r);
          hop();
        },
      });
    };
    hop();
  },
});

function explode(u: Unit, a: AbilityInst, r: Unit) {
  const rad = val(a, 'radius');
  u.w.emit({ n: 'fire_remnant_explode', x: r.x, y: r.y, r: rad, t: u.team });
  for (const e of foes(u, r.x, r.y, rad, a)) damage(u, e, dmg(a, 'damage'), 'magical', a);
  if (r.alive) { r.alive = false; r.hp = 0; u.w.removeLater(r, 0.1); }
}

// Innata: arde siempre, dañando alrededor.
function immolationSpec(a: AbilityInst, src: Unit): ModSpec {
  const tick = val(a, 'tick_interval');
  return {
    name: 'immolation', interval: tick,
    onInterval(m) {
      const o = m.owner as Unit;
      if (!o.alive) return;
      for (const e of foes(src, o.x, o.y, val(a, 'radius'), a)) {
        damage(src, e, dmg(a, 'damage') * tick, 'magical', a, { noProc: true });
      }
    },
  };
}
defineAbility({
  key: 'ember_spirit_immolation', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => immolationSpec(a, a.owner as Unit),
});

defineAbility({
  key: 'ember_spirit_fire_remnant', target: 'point', ult: true, ai: { role: 'nuke' },
  castRange: (a) => (hasScepter(a.owner as Unit) ? val(a, 'scepter_range') : val(a, 'abilitycastrange')),
  castBeyond: true,
  charges: (a) => [hasScepter(a.owner as Unit) ? val(a, 'scepter_max_charges') : val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')],
  // Shard: recupera una carga si muere un héroe enemigo cerca.
  passive: (a) => ({
    name: 'fire_remnant_shard',
    onAnyDeath(m, victim) {
      const u = m.owner as Unit;
      if (!hasShard(u) || victim.kind !== 'hero' || victim.team === u.team) return;
      if (Math.hypot(victim.x - u.x, victim.y - u.y) > val(a, 'shard_charge_radius')) return;
      const [max] = a.impl.charges!(a);
      if (a.charges < max) a.charges++;
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const range = hasScepter(u) ? val(a, 'scepter_range') : val(a, 'abilitycastrange');
    let dx = t.x - u.x, dy = t.y - u.y;
    const d = Math.hypot(dx, dy) || 1;
    const go = Math.min(d, range * a.upg.range + u.s.castRange);
    dx /= d; dy /= d;
    const tx = u.x + dx * go, ty = u.y + dy * go;
    const speed = u.s.ms * val(a, 'speed_multiplier') / 100 * (hasScepter(u) ? val(a, 'scepter_speed_multiplier') : 1);
    const r = u.w.spawnSummon(u, 'ember_spirit_remnant', u.x, u.y, dur(a, 'duration'), { abilities: [] });
    r.addMod({
      name: 'fire_remnant', persistent: true, fx: 'fire_remnant',
      states: ST.invulnerable | ST.untargetable | ST.noCollision | ST.disarmed | ST.busy,
      onTick(_m, dt) {
        if (r.data_arrived) return;
        const left = Math.hypot(tx - r.x, ty - r.y);
        const step = speed * dt;
        if (left <= step) { r.x = tx; r.y = ty; r.data_arrived = true; return; }
        r.x += (tx - r.x) / left * step;
        r.y += (ty - r.y) / left * step;
      },
    }, u, a);
    // Shard: los remanentes también arden.
    const imm = ab(u, 'ember_spirit_immolation');
    if (imm && hasShard(u) && val(a, 'apply_immolation_to_remnant') > 0) r.addMod({ ...immolationSpec(imm, u), persistent: true }, u, imm);
  },
});

defineHero('ember_spirit', ['ember_spirit_searing_chains', 'ember_spirit_sleight_of_fist', 'ember_spirit_flame_guard', 'ember_spirit_activate_fire_remnant', 'ember_spirit_immolation', 'ember_spirit_fire_remnant'], {
  build: ['magic_wand', 'phase_boots', 'maelstrom', 'black_king_bar', 'mjollnir', 'kaya_and_sange', 'shivas_guard', 'refresher'],
  upgrades: [
    { slot: 0, key: 'duration', amount: 0.25, max: 4, label: 'Searing Chains: +0,25 s' },
    { slot: 0, key: 'damage_per_second', amount: 20, max: 5, label: 'Searing Chains: +20 daño por segundo' },
    { slot: 1, key: 'bonus_hero_damage', amount: 20, max: 5, label: 'Sleight of Fist: +20 daño a héroes' },
    { slot: 1, key: 'radius', amount: 40, max: 4, label: 'Sleight of Fist: +40 de radio' },
    { slot: 2, key: 'absorb_amount', amount: 60, max: 5, label: 'Flame Guard: +60 de escudo' },
    { slot: 5, key: 'damage', amount: 30, max: 5, label: 'Fire Remnant: +30 daño' },
    { slot: 5, key: 'abilitychargerestoretime', amount: -3, max: 4, label: 'Fire Remnant: −3 s de recarga' },
  ],
});
