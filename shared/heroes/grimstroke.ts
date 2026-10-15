import { defineAbility, defineHero, dmg, dur, hasShard, isItem, val } from '../sim/abilities';
import { creditHero, damage, heal } from '../sim/combat';
import type { AbilityInst, ItemInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botCast, nearestEnemyHero } from './lib/a3';
import { castDir, debuff, slow, stun } from './util';

/** Copias de hechizos creadas por Soulbind (para el talento de daño extra). */
const soulCopies = new WeakSet<object>();

defineAbility({
  key: 'grimstroke_dark_artistry', target: 'point', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    let heroes = 0, creeps = 0;
    const w = u.w;
    // Aproximación: trazo recto desde Grimstroke (sin la curva del vector).
    w.addProjectile({
      kind: 'linear', fx: 'stroke_of_fate', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'projectile_speed'),
      left: val(a, 'abilitycastrange') * a.upg.range + u.s.castRange,
      width: val(a, 'start_radius') * 2, widthEnd: val(a, 'end_radius') * 2,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.kind === 'ward' || v.has(ST.magicImmune)) return;
        const amount = dmg(a, 'damage') + heroes * dmg(a, 'bonus_damage_per_hero') + creeps * dmg(a, 'bonus_damage_per_creep');
        if (v.isHeroLike) heroes++; else creeps++;
        damage(u, v, amount, 'magical', a);
        slow(u, v, a, 'stroke_of_fate_slow', dur(a, 'slow_duration'), val(a, 'movement_slow_pct') / 100);
        w.addVision(u.team, v.x, v.y, 300, val(a, 'vision_duration'), false);
      },
    });
  },
});

defineAbility({
  key: 'grimstroke_ink_creature', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e?.alive) return;
    const w = u.w;
    const latch = val(a, 'latch_duration');
    const ph = w.spawnSummon(u, 'grimstroke_ink_creature', u.x, u.y, latch + 6, { abilities: [] });
    ph.addMod({
      name: 'phantom', persistent: true, fx: 'phantom', states: ST.busy | ST.noCollision | ST.flying | ST.disarmed,
      data: { hits: 0, latched: 0, tick: 0 },
      // Solo muere a golpes: los de héroe cuentan triple.
      onIncomingDamage(m, ev) {
        if (!ev.isAttack) { ev.amount = 0; return; }
        const src = ev.source as Unit;
        m.data.hits += src?.isHeroLike ? val(a, 'hero_attack_multiplier') : 1;
        ev.amount = m.data.hits >= val(a, 'destroy_attacks') ? ph.hp + 1 : 0;
      },
      onTick(m, dt) {
        if (!e.alive || !w.targetable(e)) { ph.expireAt = w.time; return; }
        const d = Math.hypot(e.x - ph.x, e.y - ph.y);
        if (!m.data.latched) {
          const step = val(a, 'speed') * dt;
          if (d > val(a, 'latched_unit_offset') + step) {
            ph.facing = Math.atan2(e.y - ph.y, e.x - ph.x);
            ph.x += (e.x - ph.x) / d * step; ph.y += (e.y - ph.y) / d * step;
            return;
          }
          // Se engancha: silencio y daño en el tiempo.
          if (e.team === u.team || (e.has(ST.magicImmune) && !a.def.bkbPierce)) { ph.expireAt = w.time; return; }
          m.data.latched = w.time;
          ph.expireAt = w.time + latch + 0.1;
          debuff(u, e, a, { name: 'phantoms_embrace', duration: latch, states: ST.silenced, fx: 'silence', purgable: false });
        }
        // Pegado al objetivo.
        const off = val(a, 'latched_unit_offset_short');
        ph.x = e.x - Math.cos(e.facing) * off; ph.y = e.y - Math.sin(e.facing) * off;
        m.data.tick += dt;
        const iv = val(a, 'tick_interval');
        if (m.data.tick >= iv) {
          m.data.tick -= iv;
          damage(u, e, dmg(a, 'damage_per_second') * iv, 'magical', a, { noProc: true });
        }
        if (w.time - m.data.latched >= latch) {
          // Sobrevivió: estallido y Phantom's Embrace se recarga.
          damage(u, e, dmg(a, 'pop_damage'), 'magical', a);
          w.emit({ n: 'phantom_pop', x: e.x, y: e.y, u: e.id });
          if (!a.temp) a.cd = 0;
          m.data.latched = -1;
          ph.expireAt = w.time;
        }
      },
      onDestroy() { const s = e.findMod('phantoms_embrace', u); if (s) e.removeMod(s); },
      onDeath() { const s = e.findMod('phantoms_embrace', u); if (s) e.removeMod(s); },
    }, u, a);
  },
});

// Ink Swell: sobre un aliado. Los bots lo lanzan con botCast (la IA genérica solo apunta a enemigos).
defineAbility({
  key: 'grimstroke_spirit_walk', target: 'unit', team: 'ally', allowSelf: true,
  aoe: (a) => val(a, 'radius'),
  passive: (a) => botCast(a, (u) => {
    const r = val(a, 'radius');
    const enemy = nearestEnemyHero(u, 1400);
    if (!enemy) return null;
    let best: Unit | null = null, bd = Infinity;
    for (const al of u.w.alliesIn(u.team, u.x, u.y, 800, { heroes: true })) {
      if (al.kind !== 'hero') continue;
      const d = Math.hypot(enemy.x - al.x, enemy.y - al.y);
      if (d < bd) { bd = d; best = al; }
    }
    return best && bd < r + 350 ? best : null;
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const al = t.unit as Unit;
    if (!al?.alive) return;
    const shard = hasShard(u);
    if (shard) al.purge(true, false);
    const r = val(a, 'radius');
    const iv = val(a, 'tick_rate');
    const amp = 1 + val(a, 'shard_bonus_damage_pct') / 100;
    const healPct = val(a, 'shard_heal_pct') / 100;
    const creepPen = val(a, 'shard_creep_penalty');
    const healFrom = (v: Unit, amount: number) => {
      if (healPct > 0) heal(al, amount * healPct * (v.isHeroLike ? 1 : creepPen), u, true);
    };
    al.addMod({
      name: 'ink_swell', duration: val(a, 'buff_duration'), fx: 'ink_swell', interval: iv, data: { near: 0 },
      props: { msPct: val(a, 'movespeed_bonus_pct') / 100 },
      onInterval(m) {
        let hero = false;
        for (const e of u.w.enemiesIn(u.team, al.x, al.y, r)) {
          if (e.has(ST.magicImmune)) continue;
          if (e.isHeroLike) hero = true;
          healFrom(e, damage(u, e, dmg(a, 'damage_per_tick') * amp, 'magical', a, { noProc: true }));
        }
        if (hero) m.data.near += iv;
      },
      onDestroy(m) {
        if (!al.alive) return;
        const k = Math.min(1, m.data.near / val(a, 'max_threshold_duration'));
        u.w.emit({ n: 'ink_swell_burst', x: al.x, y: al.y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, al.x, al.y, r)) {
          if (e.has(ST.magicImmune)) continue;
          healFrom(e, damage(u, e, dmg(a, 'max_damage') * k * amp, 'magical', a));
          if (k > 0) stun(u, e, val(a, 'max_stun') * k, a);
        }
      },
    }, u, a);
  },
});

// Dark Portrait (Scepter): ilusión de tinta de un héroe enemigo bajo control de Grimstroke.
defineAbility({
  key: 'grimstroke_dark_portrait', target: 'unit', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e?.alive || !e.isHeroLike) return;
    const src = e.kind === 'illusion' ? (e.owner as Unit) ?? e : e;
    const ang = u.w.rng() * Math.PI * 2;
    const il = u.w.spawnIllusion(src, e.x + Math.cos(ang) * 120, e.y + Math.sin(ang) * 120, val(a, 'illusion_duration'),
      val(a, 'images_do_damage_percent') / 100, val(a, 'images_take_damage_percent') / 100, u);
    il.team = u.team; il.owner = u; il.playerId = u.playerId;
    il.addMod({
      name: 'dark_portrait', persistent: true, fx: 'dark_portrait', states: ST.magicImmune,
      props: { msPct: val(a, 'images_movespeed_bonus') / 100, magicResist: val(a, 'immunity_resist') / 100 },
    }, u, a);
    u.w.issueOrder(il, { type: 'attack', target: e.id });
  },
});

/** Copia un hechizo con objetivo al otro héroe encadenado. */
function soulCopy(caster: Unit, spell: AbilityInst | ItemInst, to: Unit) {
  if (!spell.impl?.onSpellStart || (spell as AbilityInst).temp || !to.alive) return;
  const copy = { ...spell, temp: true, data: {} } as AbilityInst | ItemInst;
  if (!isItem(copy)) copy.passiveMod = null;
  soulCopies.add(copy);
  to.w.emit({ n: 'soulbind_copy', x: to.x, y: to.y, u: to.id, u2: caster.id });
  spell.impl.onSpellStart(copy as any, { unit: to, x: to.x, y: to.y });
}

defineAbility({
  key: 'grimstroke_soul_chain', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'chain_latch_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e?.alive) return;
    const w = u.w;
    let d = dur(a, 'chain_duration');
    if (!e.isHeroLike) d *= val(a, 'creep_duration_pct') / 100;
    const latchR = val(a, 'chain_latch_radius');
    const leash = val(a, 'chain_latch_radius') + val(a, 'leash_radius_buffer');
    const breakD = val(a, 'chain_break_distance');
    const amp = 1 + val(a, 'bonus_reflected_spell_damage') / 100;
    const partnerMod = (p: Unit, other: Unit) => debuff(u, p, a, {
      name: 'soulbind_partner', duration: d, fx: 'soulbind', purgable: false, data: { other: other.id },
      onTargeted(_m, caster, spell) { soulCopy(caster as Unit, spell, other); return false; },
      onIncomingDamage(_m, ev) { if (ev.ability && soulCopies.has(ev.ability)) ev.amount *= amp; },
    });
    const main = debuff(u, e, a, {
      name: 'soulbind', duration: d, fx: 'soulbind', purgable: false, data: { other: 0 },
      onTargeted(m, caster, spell) {
        const o = w.units.get(m.data.other);
        if (o?.alive) soulCopy(caster as Unit, spell, o);
        return false;
      },
      onIncomingDamage(_m, ev) { if (ev.ability && soulCopies.has(ev.ability)) ev.amount *= amp; },
      onTick(m) {
        let o = w.units.get(m.data.other);
        const dd = o ? Math.hypot(o.x - e.x, o.y - e.y) : Infinity;
        if (!o || !o.alive || dd > breakD) {
          // Se rompe: busca otro aliado cercano.
          if (o) { const pm = o.findMod('soulbind_partner', u); if (pm) o.removeMod(pm); }
          m.data.other = 0; o = undefined;
          const cands = w.alliesIn(e.team, e.x, e.y, latchR, { heroes: true }).filter((x) => x !== e);
          cands.sort((p, q) => Math.hypot(p.x - e.x, p.y - e.y) - Math.hypot(q.x - e.x, q.y - e.y));
          const n = cands[0];
          if (n && partnerMod(n, e)) {
            const pm = n.findMod('soulbind_partner', u)!;
            pm.remaining = m.remaining;
            m.data.other = n.id; o = n;
            w.emit({ n: 'soulbind', x: e.x, y: e.y, x2: n.x, y2: n.y, u: e.id, u2: n.id });
          }
          return;
        }
        // Correa: no pueden separarse más allá del radio.
        const dist = Math.hypot(o.x - e.x, o.y - e.y);
        if (dist > leash) {
          const k = (dist - leash) / 2 / dist;
          const ox = (o.x - e.x) * k, oy = (o.y - e.y) * k;
          w.forceMove(e, e.x + ox, e.y + oy);
          w.forceMove(o, o.x - ox, o.y - oy);
        }
      },
      onDestroy(m) {
        const o = w.units.get(m.data.other);
        const pm = o?.findMod('soulbind_partner', u);
        if (o && pm) o.removeMod(pm);
      },
    });
    if (main) w.emit({ n: 'soul_chain', x: e.x, y: e.y, r: latchR, u: e.id, t: u.team });
  },
});

// Ink Trail: los enemigos tocados por sus ataques o hechizos le hacen menos daño.
defineAbility({
  key: 'grimstroke_ink_trail', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'ink_trail',
    onDealDamage(m, ev) {
      const u = m.owner as Unit;
      const v = ev.target as Unit;
      if (v.team === u.team || !v.isHeroLike || !v.alive || ev.hpRemoval) return;
      debuff(u, v, a, { name: 'ink_trail', duration: val(a, 'debuff_duration'), fx: 'ink_trail' });
    },
    onIncomingDamage(m, ev) {
      const u = m.owner as Unit;
      const src = creditHero(ev.source as Unit | null) ?? (ev.source as Unit | null);
      if (src && ((ev.source as Unit).findMod('ink_trail', u) || src.findMod('ink_trail', u))) {
        ev.amount *= 1 - val(a, 'damage_reduction') / 100;
      }
    },
  }),
});

defineHero('grimstroke', [
  'grimstroke_dark_artistry', 'grimstroke_ink_creature', 'grimstroke_spirit_walk', 'grimstroke_dark_portrait',
  'grimstroke_soul_chain', 'grimstroke_ink_trail',
], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'aether_lens', 'ultimate_scepter', 'octarine_core'],
});
