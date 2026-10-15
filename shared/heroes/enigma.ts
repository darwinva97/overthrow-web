import { UNITS } from '../data';
import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { BaseStats, Unit } from '../sim/unit';
import { angleTo, botCast, botCommand, nearestEnemyHero, summonsOf } from './lib/a3';
import { debuff, stun } from './util';

const demonicOf = (u: Unit) => u.abilities.find((x) => x.key === 'enigma_demonic_conversion');

/** Eidolon con los stats del nivel de Demonic Conversion. `split`: puede multiplicarse. */
function spawnEidolon(owner: Unit, a: AbilityInst, x: number, y: number, duration: number, split: boolean): Unit {
  const d = UNITS.lesser_eidolon;
  const base: BaseStats = {
    hp: val(a, 'eidelon_max_health') + owner.hp * val(a, 'current_health_pct') / 100,
    hpRegen: d?.hpRegen ?? 0, mana: 0, manaRegen: 0, armor: d?.armor ?? 0,
    mr: val(a, 'eidolon_magic_resist'),
    dmgMin: val(a, 'eidelon_base_damage') - val(a, 'eidolon_damage_spread'),
    dmgMax: val(a, 'eidelon_base_damage') + val(a, 'eidolon_damage_spread'),
    bat: d?.bat ?? 1.5, attackPoint: d?.attackPoint ?? 0.2, range: val(a, 'eidolon_attack_range'),
    projSpeed: d?.projSpeed ?? 900, ms: val(a, 'eidelon_base_movespeed'),
    dayVision: d?.dayVision ?? 1200, nightVision: d?.nightVision ?? 800, turnRate: d?.turnRate ?? 0.9, melee: false,
  };
  const gold = val(a, 'eidolon_gold_bounty_min') + Math.floor(owner.w.rng() * (val(a, 'eidolon_gold_bounty_max') - val(a, 'eidolon_gold_bounty_min') + 1));
  const red = split ? 1 : 1 - val(a, 'non_splitting_bounty_reduction') / 100;
  const e = owner.w.spawnSummon(owner, base, x, y, duration, {
    name: 'eidolon', abilities: [], bounty: Math.round(gold * red), xp: Math.round(val(a, 'eidolon_xp_bounty') * red),
  });
  e.addMod({
    name: 'eidolon', persistent: true, data: { hits: 0, split },
    props: { damage: val(a, 'eidolon_bonus_damage') * a.upg.dmg, attackSpeed: val(a, 'eidolon_bonus_attack_speed') },
    onAttackLanded(m, ev) {
      if (!m.data.split || ev.fake || ev.target.team === e.team) return;
      if (++m.data.hits < val(a, 'split_attack_count')) return;
      // Se divide una vez: las dos quedan curadas y viven un poco más.
      m.data.split = false;
      const left = e.expireAt - e.w.time + val(a, 'life_extension');
      e.expireAt = e.w.time + left;
      heal(e, e.s.maxHp, null, true);
      const ang = e.w.rng() * Math.PI * 2;
      const c = spawnEidolon(owner, a, e.x + Math.cos(ang) * 60, e.y + Math.sin(ang) * 60, left, false);
      e.w.issueOrder(c, { type: 'attack', target: ev.target.id });
    },
  }, owner, a);
  return e;
}

defineAbility({
  key: 'enigma_malefice', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e?.alive) return;
    const tick = val(a, 'tick_rate');
    const n = val(a, 'stun_instances');
    const strike = (m: { data: Record<string, any> }) => {
      const v = e;
      if (!v.alive) return;
      m.data.done++;
      v.w.emit({ n: 'malefice', x: v.x, y: v.y, u: v.id });
      damage(u, v, dmg(a, 'damage'), 'magical', a);
      stun(u, v, val(a, 'stun_duration'), a);
      // Shard: un Eidolon junto al objetivo en cada golpe (no se multiplica).
      const dc = demonicOf(u);
      const spawns = val(a, 'eidolon_spawns_per_tick');
      if (spawns > 0 && dc && dc.level > 0 && u.kind === 'hero') {
        for (let i = 0; i < spawns; i++) {
          const ang = u.w.rng() * Math.PI * 2;
          const s = spawnEidolon(u, dc, v.x + Math.cos(ang) * 100, v.y + Math.sin(ang) * 100, val(dc, 'abilityduration'), false);
          if (v.team !== u.team) u.w.issueOrder(s, { type: 'attack', target: v.id });
        }
      }
    };
    debuff(u, e, a, {
      name: 'malefice', duration: tick * (n - 1) + 0.1, interval: tick, fx: 'malefice', data: { done: 0 },
      onCreated(m) { strike(m); },
      onInterval(m) { if (m.data.done < n) strike(m); },
    });
  },
});

defineAbility({
  key: 'enigma_demonic_conversion', target: 'point',
  passive: (a) => {
    const spec = botCast(a, (u) => {
      if (u.hp / u.s.maxHp < 0.45 || summonsOf(u, 'eidolon').length > 2) return null;
      const near = nearestEnemyHero(u, 1000) ?? u.w.list.find((c) => c.kind === 'creep' && c.alive && Math.hypot(c.x - u.x, c.y - u.y) < 600);
      return near ? { x: u.x + Math.cos(u.facing) * 150, y: u.y + Math.sin(u.facing) * 150 } : null;
    }, 0.5);
    const base = spec.onInterval!;
    spec.onInterval = (m) => {
      base(m);
      const u = m.owner as Unit;
      if (u.isBot) botCommand(u, summonsOf(u, 'eidolon'));
    };
    return spec;
  },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    // Cuesta vida (no letal).
    u.hp = Math.max(1, u.hp - val(a, '_hc'));
    const n = val(a, 'spawn_count');
    const off = val(a, 'spawn_offset');
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      spawnEidolon(u, a, t.x + Math.cos(ang) * off, t.y + Math.sin(ang) * off, dur(a, 'abilityduration'), true);
    }
    u.w.emit({ n: 'demonic_conversion', x: t.x, y: t.y, u: u.id });
  },
});

defineAbility({
  key: 'enigma_midnight_pulse', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const tick = val(a, 'tick_rate');
    u.w.cutTrees(t.x, t.y, r);
    u.w.addZone({
      fx: 'midnight_pulse', x: t.x, y: t.y, r, team: u.team, interval: tick, duration: dur(a, 'duration'),
      onInterval(z) {
        for (const e of u.w.enemiesIn(u.team, z.x, z.y, z.r)) {
          const amount = (dmg(a, 'base_damage') + e.hp * val(a, 'damage_percent') / 100 * a.upg.dmg) * tick;
          damage(u, e, amount, 'magical', a, { noProc: true });
        }
      },
    });
  },
});

// Event Horizon: quien se aleja de Enigma dentro del radio va más lento.
defineAbility({
  key: 'enigma_event_horizon', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'event_horizon',
    aura: {
      radius: val(a, 'radius'), team: 'enemy',
      apply: (m) => ({
        name: 'event_horizon_slow', debuff: true, data: { away: false },
        props: (mm) => (mm.data.away ? { msSlow: val(a, 'speed_bonus') / 100 } : {}),
        onTick(mm) {
          const v = mm.owner as Unit, en = m.owner as Unit;
          const moving = v.path.length > 0 || v.order?.type === 'move';
          const away = moving && angleTo(v, en.x, en.y) > Math.PI / 2;
          if (away !== mm.data.away) { mm.data.away = away; v.refreshStats(); }
        },
      }),
    },
  }),
});

defineAbility({
  key: 'enigma_black_hole', target: 'point', ult: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    a.data.x = t.x; a.data.y = t.y; a.data.acc = 0;
    const u = a.owner as Unit;
    u.w.addVision(u.team, t.x, t.y, val(a, 'vision_radius'), val(a, 'abilitychanneltime'));
    u.w.emit({ n: 'black_hole', x: t.x, y: t.y, r: val(a, 'radius'), d: val(a, 'abilitychanneltime'), t: u.team });
  },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const cx = a.data.x, cy = a.data.y;
    const r = val(a, 'radius');
    const tick = val(a, 'tick_rate');
    a.data.acc += dt;
    const doDamage = a.data.acc >= tick;
    if (doDamage) a.data.acc -= tick;
    const sc = hasScepter(u);
    const reach = sc ? Math.max(r, val(a, 'scepter_radius')) : r;
    for (const e of u.w.enemiesIn(u.team, cx, cy, reach)) {
      const d = Math.hypot(e.x - cx, e.y - cy);
      const inside = d <= r + e.radius;
      if (inside) {
        const had = !!e.findMod('black_hole', u);
        const m = debuff(u, e, a, { name: 'black_hole', duration: 0.15, states: ST.stunned, fx: 'black_hole', purgable: false });
        if (!m) continue;
        if (!had) { e.atk.phase = 0; if (e.cast) e.w.interruptCast(e, true); }
        // Remolino hacia el centro.
        if (d > 10) {
          const pull = val(a, 'pull_speed') * dt;
          const rot = (sc ? val(a, 'scepter_pull_rotate_speed') : val(a, 'pull_rotate_speed')) * dt;
          const ang = Math.atan2(e.y - cy, e.x - cx) + rot;
          const nd = Math.max(0, d - pull);
          u.w.forceMove(e, cx + Math.cos(ang) * nd, cy + Math.sin(ang) * nd);
        }
        if (doDamage) {
          let amount = dmg(a, 'damage') * tick;
          if (sc) amount += e.s.maxHp * val(a, 'scepter_pct_damage') / 100 * tick;
          damage(u, e, amount, 'pure', a, { noProc: true });
        }
      } else if (sc && d > 10) {
        // Scepter: arrastre sin interrumpir en un área mayor.
        const pull = val(a, 'scepter_drag_speed') * dt;
        u.w.forceMove(e, e.x + (cx - e.x) / d * pull, e.y + (cy - e.y) / d * pull);
      }
    }
  },
  onChannelEnd(a) {
    const u = a.owner as Unit;
    for (const e of u.w.list) { const m = e.findMod('black_hole', u); if (m) e.removeMod(m); }
  },
});

defineHero('enigma', ['enigma_malefice', 'enigma_demonic_conversion', 'enigma_midnight_pulse', 'enigma_event_horizon', 'enigma_black_hole'], {
  build: ['null_talisman', 'arcane_boots', 'blink', 'black_king_bar', 'ultimate_scepter', 'refresher', 'octarine_core'],
});
