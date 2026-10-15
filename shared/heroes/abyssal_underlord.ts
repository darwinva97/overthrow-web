import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, root, slow } from './util';
import { botOnly, dist, enemyHeroes } from './lib/a1';

defineAbility({
  key: 'abyssal_underlord_firestorm', target: 'unitOrPoint', team: 'any', allowSelf: true, ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    // Con Shard puede lanzarse sobre un aliado: la tormenta le sigue.
    const follow = t.unit && t.unit.team === u.team && val(a, 'can_target_units') > 0 ? t.unit as Unit : null;
    const r = val(a, 'radius');
    const waves = val(a, 'wave_count') + val(a, 'shard_wave_count_bonus');
    const every = val(a, 'wave_interval') * (1 - val(a, 'shard_wave_interval_reduction') / 100);
    const burnPct = val(a, 'burn_damage') / 100;
    let x = t.x, y = t.y, n = 0;
    const wave = () => {
      if (follow?.alive) { x = follow.x; y = follow.y; }
      u.w.emit({ n: 'firestorm', x, y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, x, y, r)) {
        damage(u, e, dmg(a, 'wave_damage'), 'magical', a);
        debuff(u, e, a, {
          name: 'firestorm_burn', duration: val(a, 'burn_duration'), interval: val(a, 'burn_interval'), fx: 'burn',
          onInterval(m) { const v = m.owner as Unit; damage(u, v, v.s.maxHp * burnPct * a.upg.dmg, 'magical', a, { noProc: true }); },
        });
      }
      if (++n < waves) u.w.after(every, wave);
    };
    wave();
  },
});

function pit(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const r = val(a, 'radius');
  const hitAt = new Map<number, number>();
  u.w.addZone({
    fx: 'pit_of_malice', x, y, r, team: u.team, interval: 0.1, duration: dur(a, 'pit_duration'),
    onInterval(z) {
      for (const e of u.w.enemiesIn(u.team, z.x, z.y, z.r)) {
        const sb = val(a, 'speed_bonus');
        if (sb > 0) slow(u, e, a, 'pit_of_malice_slow', 0.2, sb / 100);
        const last = hitAt.get(e.id);
        if (last !== undefined && u.w.time - last < val(a, 'pit_interval')) continue;
        hitAt.set(e.id, u.w.time);
        damage(u, e, dmg(a, 'pit_damage'), 'magical', a);
        root(u, e, val(a, 'ensnare_duration'), a, 'pit_of_malice');
      }
    },
  });
}

defineAbility({
  key: 'abyssal_underlord_pit_of_malice', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) { pit(a, t.x, t.y); },
});

defineAbility({
  key: 'abyssal_underlord_atrophy_aura', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'atrophy_aura',
    aura: {
      radius: val(a, 'radius'), team: 'enemy',
      apply: () => ({ name: 'atrophy', debuff: true, purgable: false, props: { damagePct: -val(a, 'damage_reduction_pct') / 100 } }),
    },
    onAnyDeath(m, victim) {
      const u = m.owner as Unit;
      if (victim.team === u.team || !victim.findMod('atrophy', u)) return;
      const bonus = victim.isHeroLike && victim.kind === 'hero' ? val(a, 'bonus_damage_from_hero') : val(a, 'bonus_damage_from_creep');
      u.addMod({ name: 'atrophy_bonus', duration: val(a, 'bonus_damage_duration'), props: { damage: bonus }, data: { multi: true } }, u, a);
    },
  }),
});

/** Bonus de Raid Boss tras un teletransporte aliado. */
function raidBoss(u: Unit, hero: Unit, mult: number) {
  const rb = u.abilities.find((x) => x.key === 'abyssal_underlord_raid_boss');
  if (!rb || rb.level <= 0) return;
  hero.addMod({
    name: 'raid_boss', duration: val(rb, 'buff_duration'), fx: 'haste',
    props: { msPct: val(rb, 'bonus_ms') * mult / 100, incomingPct: -val(rb, 'damage_reduction') * mult / 100 },
  }, u, rb);
}

// Innata. En Overthrow no hay pergaminos de teletransporte: solo cuenta Fiend's Gate (x2).
defineAbility({ key: 'abyssal_underlord_raid_boss', target: 'passive', innate: true });

defineAbility({
  key: 'abyssal_underlord_dark_portal', target: 'point', ult: true, castBeyond: true,
  castRange: () => 1e5,
  // Bots: abren portal hacia su fuente al huir.
  passive: (a) => botOnly(a, (u) => {
    if (u.hp / u.s.maxHp > 0.4 || !enemyHeroes(u, 900).length) return null;
    const f = u.w.teams[u.team].fountain;
    return { x: f.x, y: f.y };
  }, 0.5),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const ang = u.facing;
    const p1 = { x: u.x + Math.cos(ang) * 100, y: u.y + Math.sin(ang) * 100 };
    let p2 = { x: t.x, y: t.y };
    const min = val(a, 'minimum_distance');
    const d = dist(p1, p2);
    if (d < min) {
      const dx = d > 1 ? (p2.x - p1.x) / d : Math.cos(ang), dy = d > 1 ? (p2.y - p1.y) / d : Math.sin(ang);
      p2 = { x: p1.x + dx * min, y: p1.y + dy * min };
    }
    p2 = u.w.grid.nearestFree(p2.x, p2.y);
    const duration = dur(a, 'duration');
    const channel = val(a, 'warp_channel_duration');
    const standing = new Map<number, { t: number; x: number; y: number }>();
    const portals = [p1, p2];
    portals.forEach((p, i) => {
      const other = portals[1 - i];
      u.w.addZone({
        fx: 'dark_portal', x: p.x, y: p.y, r: 150, team: u.team, interval: 0.1, duration,
        onInterval(z) {
          // Un héroe aliado quieto junto al portal durante la canalización pasa al otro lado.
          for (const h of u.w.alliesIn(u.team, z.x, z.y, z.r, { heroes: true })) {
            if (h.kind !== 'hero') continue;
            const s = standing.get(h.id);
            const busy = h.order && h.order.type !== 'hold' && h.order.type !== 'stop';
            if (!s || busy || Math.hypot(s.x - h.x, s.y - h.y) > 10 || h.has(ST.stunned)) {
              standing.set(h.id, { t: 0, x: h.x, y: h.y });
              continue;
            }
            s.t += 0.1;
            if (s.t >= channel) {
              standing.delete(h.id);
              u.w.emit({ n: 'tp', x: h.x, y: h.y, x2: other.x, y2: other.y, u: h.id });
              u.w.teleport(h, other.x, other.y);
              const rb = u.abilities.find((x) => x.key === 'abyssal_underlord_raid_boss');
              raidBoss(u, h, rb ? val(rb, 'dark_portal_multiplier') : 2);
            }
          }
          // Talento: daño alrededor de las puertas.
          const dps = val(a, 'dps');
          if (dps > 0) for (const e of u.w.enemiesIn(u.team, z.x, z.y, val(a, 'radius'))) damage(u, e, dps * 0.1, 'magical', a, { noProc: true });
        },
      });
      u.w.addVision(u.team, p.x, p.y, 400, duration);
    });
    // Scepter: un Pit of Malice en cada portal.
    const pitA = u.abilities.find((x) => x.key === 'abyssal_underlord_pit_of_malice');
    if (hasScepter(u) && val(a, 'spawn_pit_on_cast') > 0 && pitA && pitA.level > 0) for (const p of portals) pit(pitA, p.x, p.y);
  },
});

defineHero('abyssal_underlord', ['abyssal_underlord_firestorm', 'abyssal_underlord_pit_of_malice', 'abyssal_underlord_atrophy_aura', 'abyssal_underlord_raid_boss', 'abyssal_underlord_dark_portal'], {
  build: ['bracer', 'arcane_boots', 'vanguard', 'pipe', 'crimson_guard', 'shivas_guard', 'ultimate_scepter'],
});
