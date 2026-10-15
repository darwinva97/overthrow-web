import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, giveMana, kill } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botBrain, nearestEnemyHero } from './lib/a4';
import { canDebuff, debuff, slow } from './util';

const abil = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Frost Blast: daño al objetivo y en área, con ralentizado. */
function frostBlast(a: AbilityInst, x: number, y: number, primary: Unit | null) {
  const u = a.owner as Unit;
  const r = val(a, 'radius');
  const d = dur(a, 'abilityduration');
  u.w.emit({ n: 'frost_blast', x, y, r, t: u.team });
  if (primary && canDebuff(u, primary, a)) {
    damage(u, primary, dmg(a, 'damage'), 'magical', a);
    slow(u, primary, a, 'frost_blast_slow', d, Math.abs(val(a, 'slow_movement_speed')) / 100, Math.abs(val(a, 'slow_attack_speed_primary')));
  }
  for (const e of u.w.enemiesIn(u.team, x, y, r)) {
    if (!canDebuff(u, e, a)) continue;
    damage(u, e, dmg(a, 'aoe_damage'), 'magical', a);
    if (e !== primary) slow(u, e, a, 'frost_blast_slow', d, Math.abs(val(a, 'slow_movement_speed')) / 100);
  }
}

defineAbility({
  key: 'lich_frost_nova', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const e = t.unit as Unit;
    if (e) frostBlast(a, e.x, e.y, e);
  },
});

defineAbility({
  key: 'lich_frost_shield', target: 'unit', team: 'ally', allowSelf: true,
  // Talento: cargas. Sin él, una sola carga con el enfriamiento normal.
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), val(a, 'abilitychargerestoretime') * (1 - (a.owner as Unit).s.cdr)],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const al = t.unit as Unit;
    if (!al) return;
    const red = val(a, 'damage_reduction') / 100;
    al.addMod({
      name: 'frost_shield', duration: dur(a, 'duration'), fx: 'frost_shield', interval: val(a, 'interval'),
      props: { hpRegen: val(a, 'health_regen') },
      onIncomingDamage(_m, ev) { if (ev.isAttack) ev.amount *= 1 - red; },
      onInterval(m) {
        const o = m.owner as Unit;
        const r = val(a, 'radius');
        u.w.emit({ n: 'frost_shield_pulse', x: o.x, y: o.y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, o.x, o.y, r)) {
          if (!canDebuff(u, e, a)) continue;
          damage(u, e, dmg(a, 'damage'), 'magical', a, { noProc: true });
          slow(u, e, a, 'frost_shield_slow', val(a, 'slow_duration'), val(a, 'movement_slow') / 100);
        }
        // Cura la Ice Spire un golpe de héroe por pulso.
        if (o.data_lichSpire) o.hp = Math.min(o.s.maxHp, o.hp + 2);
      },
    }, u, a);
  },
  // Bot: a quien reciba golpes en una pelea.
  passive: (a) => botBrain(a, (u) => {
    const range = val(a, 'abilitycastrange') + u.s.castRange;
    let best: Unit | null = null, bp = 0.9;
    for (const al of u.w.alliesIn(u.team, u.x, u.y, range, { heroes: true })) {
      if (al.kind !== 'hero' || al.findMod('frost_shield')) continue;
      if (u.w.time - al.lastHeroDamageAt > 1.5 || !nearestEnemyHero(al, 700)) continue;
      const p = al.hp / al.s.maxHp;
      if (p < bp) { bp = p; best = al; }
    }
    return best ? { target: best } : null;
  }),
});

/** Hipnotiza a `e`: camina hacia Lich y pierde maná. */
function gaze(a: AbilityInst, e: Unit, time: number, channeled: boolean) {
  const u = a.owner as Unit;
  const f = 1 - val(a, 'destination') / 100;
  const dx = u.x + (e.x - u.x) * f, dy = u.y + (e.y - u.y) * f;
  const drain = e.mana * val(a, 'mana_drain') / 100;
  const m = debuff(u, e, a, {
    name: 'sinister_gaze', duration: time, fx: 'sinister_gaze', states: ST.stunned,
    onTick(mm, dt) {
      const v = mm.owner as Unit;
      if (!channeled && (!u.alive || u.has(ST.stunned))) { v.removeMod(mm); return; }
      const d = Math.hypot(dx - v.x, dy - v.y);
      const step = Math.min(d, v.s.ms * dt);
      if (d > 5) { v.facing = Math.atan2(dy - v.y, dx - v.x); v.w.forceMove(v, v.x + (dx - v.x) / d * step, v.y + (dy - v.y) / d * step); }
      const take = Math.min(v.mana, drain * dt / time);
      v.mana -= take;
      giveMana(u, take);
    },
  });
  if (m && e.cast) e.w.interruptCast(e, true);
}

defineAbility({
  key: 'lich_sinister_gaze', target: 'unit', ai: { role: 'disable' },
  // Con Scepter no es canalizada (Lich puede seguir lanzando) y afecta a un área.
  channel: (a) => (hasScepter(a.owner as Unit) ? 0 : val(a, 'channel_duration')),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e) return;
    const time = val(a, 'channel_duration');
    const sc = hasScepter(u);
    const r = val(a, 'aoe_scepter');
    const list = sc && r > 0 ? u.w.enemiesIn(u.team, e.x, e.y, r).filter((x) => x.kind !== 'ward') : [e];
    if (!list.includes(e)) list.push(e);
    a.data.targets = list.map((x) => x.id);
    for (const x of list) gaze(a, x, sc ? time : time + 0.1, !sc);
  },
  onChannelEnd(a) {
    const u = a.owner as Unit;
    for (const id of a.data.targets ?? []) u.w.units.get(id)?.removeModsByName('sinister_gaze');
  },
});

defineAbility({
  key: 'lich_ice_spire', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'aura_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const hits = val(a, 'max_hero_attacks');
    const s = u.w.spawnSummon(u, 'lich_ice_spire', t.x, t.y, val(a, 'duration'), { kind: 'ward', abilities: [], hp: hits * 2 });
    s.data_lichSpire = true;
    const creepHit = 2 * hits / Math.max(1, val(a, 'max_creep_attacks'));
    s.addMod({
      name: 'ice_spire', persistent: true, fx: 'ice_spire', states: ST.magicImmune,
      // Solo cuenta golpes: los de héroe valen el doble que los de creep.
      onIncomingDamage(_m, ev) {
        if (!ev.isAttack) { ev.amount = 0; return; }
        ev.amount = (ev.source as Unit | null)?.isHeroLike ? 2 : creepHit;
      },
      aura: {
        radius: val(a, 'aura_radius'), team: 'enemy',
        apply: () => ({ name: 'ice_spire_slow', debuff: true, fx: 'slow', duration: val(a, 'slow_duration'),
          props: { msSlow: Math.abs(val(a, 'bonus_movespeed')) / 100 } }),
      },
      // Al romperse suelta un Frost Blast.
      onDeath() {
        const fb = abil(u, 'lich_frost_nova');
        if (fb && fb.level > 0) frostBlast(fb, s.x, s.y, null);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'lich_death_charge', target: 'unit', team: 'ally', innate: true,
  charges: (a) => [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime') * (1 - (a.owner as Unit).s.cdr)],
  // Empieza la partida sin cargas y en enfriamiento.
  passive: (a) => {
    if (!a.data.init) { a.data.init = true; a.charges = 0; a.chargeCd = val(a, 'abilitychargerestoretime'); }
    // El bot sacrifica un creep o invocación aliada cuando le falta maná.
    return botBrain(a, (u) => {
      if (u.mana > u.s.maxMana * 0.7) return null;
      const range = val(a, 'abilitycastrange') + u.s.castRange + 300;
      const c = u.w.alliesIn(u.team, u.x, u.y, range)
        .find((x) => !x.isHeroLike && x.kind !== 'ward' && x.name !== 'lich_ice_spire' && (x.kind === 'creep' || x.kind === 'summon'));
      return c ? { target: c } : null;
    }, 0.5);
  },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const c = t.unit as Unit;
    // Solo creeps e invocaciones aliadas.
    if (!c || c.isHeroLike || c.kind === 'ward' || c.team !== u.team) { a.charges++; return; }
    giveMana(u, c.hp * val(a, 'active_mana_restore_pct_of_health') / 100);
    u.addXp(c.bountyXp * val(a, 'xp_pct') / 100);
    u.w.emit({ n: 'sacrifice', x: c.x, y: c.y, u: c.id, u2: u.id });
    kill(c, null);
  },
});

/** Chain Frost: orbe que rebota entre enemigos y gana daño en cada rebote. */
function chainFrost(a: AbilityInst, first: Unit, x: number, y: number) {
  const u = a.owner as Unit;
  const w = u.w;
  const unlimited = val(a, 'has_unlimited_jumps') > 0;
  let left = val(a, 'jumps');
  let bounces = 0;
  const go = (t: Unit, fx: number, fy: number, speed: number) => {
    w.addProjectile({
      kind: 'track', fx: 'chain_frost', source: u, target: t, x: fx, y: fy, speed, dodgeable: true,
      onHit(p) {
        w.addVision(u.team, t.x, t.y, val(a, 'vision_radius'), 1);
        if (t.data_lichSpire) {
          damage(u, t, 2, 'pure', a, { hpRemoval: true, isAttack: true });
        } else if (canDebuff(u, t, a)) {
          damage(u, t, dmg(a, 'damage') + val(a, 'bonus_jump_damage') * bounces, 'magical', a);
          slow(u, t, a, 'chain_frost_slow', val(a, 'slow_duration'), Math.abs(val(a, 'slow_movement_speed')) / 100, Math.abs(val(a, 'slow_attack_speed')));
        }
        bounces++;
        if (!unlimited && --left <= 0) return true;
        bounce(t, p.x, p.y, 0);
        return true;
      },
    });
  };
  // Busca el siguiente objetivo; si no hay, se queda flotando un rato sobre el último.
  const bounce = (last: Unit, px: number, py: number, waited: number) => {
    const cx = last.alive ? last.x : px, cy = last.alive ? last.y : py;
    const r = val(a, 'jump_range');
    const list = w.enemiesIn(u.team, cx, cy, r).filter((e) => e !== last && e.kind !== 'ward' && w.canSee(u.team, e) && canDebuff(u, e, a));
    let next: Unit | null = list.length ? list[Math.floor(w.rng() * list.length)] : null;
    // Shard: puede rebotar en la Ice Spire si no hay nadie más.
    if (!next) next = w.alliesIn(u.team, cx, cy, r).find((s) => s.data_lichSpire && s !== last) ?? null;
    if (next) { go(next, cx, cy, val(a, 'projectile_speed')); return; }
    if (waited >= val(a, 'frostbound_duration')) return;
    w.after(0.1, () => bounce(last, cx, cy, waited + 0.1));
  };
  go(first, x, y, val(a, 'initial_projectile_speed'));
}

defineAbility({
  key: 'lich_chain_frost', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    if (t.unit) chainFrost(a, t.unit as Unit, u.x, u.y);
  },
  // Talento: al morir lanza un Chain Frost.
  passive: (a) => ({
    name: 'chain_frost_on_death',
    onDeath(m) {
      const u = m.owner as Unit;
      if (u.kind !== 'hero' || val(a, 'should_fire_chain_frost_on_death') <= 0) return;
      const e = nearestEnemyHero(u, val(a, 'abilitycastrange') + u.s.castRange);
      if (e) chainFrost(a, e, u.x, u.y);
    },
  }),
});

defineHero('lich', ['lich_frost_nova', 'lich_frost_shield', 'lich_sinister_gaze', 'lich_ice_spire', 'lich_death_charge', 'lich_chain_frost'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'aether_lens', 'ultimate_scepter', 'sheepstick'],
});
