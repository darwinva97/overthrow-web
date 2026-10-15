import { UNITS } from '../data';
import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { BaseStats, Unit } from '../sim/unit';
import type { Zone } from '../sim/world';
import { castDir, debuff, root, slow } from './util';
import { blindRoll, controlledBy, dist, heroOf, reveal, segDist, summonBrain } from './lib/a1';

const find = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

function spiderBase(key: string, hpBonus: number, dmgBonus: number): BaseStats {
  const d = UNITS[key];
  return {
    hp: d.hp + hpBonus, hpRegen: d.hpRegen, mana: d.mana, manaRegen: d.manaRegen, armor: d.armor, mr: d.mr,
    dmgMin: d.dmgMin + dmgBonus, dmgMax: d.dmgMax + dmgBonus, bat: d.bat, attackPoint: d.attackPoint, range: d.range,
    projSpeed: d.projSpeed, ms: d.ms, dayVision: d.dayVision, nightVision: d.nightVision, turnRate: d.turnRate || 0.6, melee: d.melee,
  };
}

defineAbility({
  key: 'broodmother_insatiable_hunger', target: 'none', ai: { role: 'buff', selfRadius: 500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const start = u.w.time;
    const bat = val(a, 'bat_bonus');
    const ls = val(a, 'lifesteal_pct') / 100;
    u.addMod({
      name: 'insatiable_hunger', duration: dur(a, 'duration'), fx: 'battle_hunger', interval: 1,
      // Shard: el daño extra crece un 4% cada segundo.
      props: () => {
        const per = val(a, 'shard_damage_per_tick');
        const ticks = per > 0 ? Math.floor((u.w.time - start) / Math.max(0.1, val(a, 'shard_damage_tick_interval'))) : 0;
        return { damage: dmg(a, 'bonus_damage') * (1 + ticks * per / 100), lifesteal: ls };
      },
      onInterval() { u.refreshStats(); },
      // Las arañas cercanas también roban vida.
      aura: {
        radius: val(a, 'aura_radius'), team: 'ally', includeSelf: false,
        apply: (_m, t) => ({ name: 'insatiable_hunger_spider', props: controlledBy(t as Unit, u) && t.kind === 'summon' ? { lifesteal: ls } : {} }),
      },
      // Talento: BAT menor mientras dura (el motor no tiene propiedad de BAT).
      onCreated(m) { if (bat > 0) { m.data.bat = u.base.bat; u.base = { ...u.base, bat: u.base.bat - bat }; } },
      onDestroy(m) { if (m.data.bat) { u.base = { ...u.base, bat: m.data.bat }; u.refreshStats(); } },
    }, u, a);
  },
});

// ---------------- Spin Web ----------------

const websOf = (a: AbilityInst): Zone[] => (a.data.webs ??= []).filter((z: Zone) => z.until > (a.owner as Unit).w.time);

defineAbility({
  key: 'broodmother_spin_web', target: 'point', ai: { role: 'buff' }, castBeyond: true,
  aoe: (a) => val(a, 'radius'),
  charges: (a) => [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    let { x, y } = t;
    // Fuera de alcance solo si toca otra telaraña; si no, se recorta al alcance.
    const range = val(a, 'abilitycastrange') * a.upg.range + u.s.castRange;
    const webs = websOf(a);
    if (dist(u, t) > range && !webs.some((z) => dist(z, t) <= r * 2)) {
      const [dx, dy] = castDir(u, x, y);
      x = u.x + dx * range; y = u.y + dy * range;
    }
    const z = u.w.addZone({
      fx: 'spin_web', x, y, r, team: u.team, interval: 0.2, duration: Infinity,
      onInterval(zz) {
        if (!u.alive || dist(u, zz) > zz.r) return;
        u.addMod({
          name: 'spin_web_buff', duration: 0.3, states: ST.noCollision,
          props: { msPct: val(a, 'bonus_movespeed') / 100, hpRegen: val(a, 'health_regen') },
        }, u, a);
      },
    });
    webs.push(z);
    // Pasado el máximo, desaparece la más antigua.
    while (webs.length > val(a, 'count')) { const old = webs.shift()!; old.until = u.w.time; }
    a.data.webs = webs;
  },
});

// ---------------- Incapacitating Bite ----------------

defineAbility({
  key: 'broodmother_incapacitating_bite', target: 'passive',
  passive: (a) => ({
    name: 'incapacitating_bite',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (ev.missed || t.team === u.team) return;
      debuff(u, t, a, {
        name: 'incapacitating_bite', duration: val(a, 'duration'), fx: 'slow',
        props: { msSlow: Math.abs(val(a, 'bonus_movespeed')) / 100 },
        // Falla ataques y recibe más daño de ataques.
        onAttackStart(_mm, aev) { blindRoll(aev, val(a, 'miss_chance') / 100); },
        onAttacked(_mm, aev) { if (!aev.missed) aev.damage += val(a, 'attack_damage'); },
      });
    },
  }),
});

// ---------------- Spinner's Snare (Scepter) ----------------

defineAbility({
  key: 'broodmother_sticky_snare', target: 'point', ai: { role: 'disable' },
  charges: (a) => [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    // Línea perpendicular a la dirección de lanzamiento, centrada en el punto.
    const [dx, dy] = castDir(u, t.x, t.y);
    const half = val(a, 'width') / 2;
    const ax = t.x - dy * half, ay = t.y + dx * half, bx = t.x + dy * half, by = t.y - dx * half;
    const armedAt = u.w.time + val(a, 'formation_delay');
    const caught = new Set<number>();
    const snares: Zone[] = (a.data.snares ??= []).filter((z: Zone) => z.until > u.w.time);
    const z = u.w.addZone({
      fx: '', x: t.x, y: t.y, r: half, team: u.team, interval: 0.1, duration: 600,
      onInterval(zz) {
        if (u.w.time < armedAt) return;
        for (const e of u.w.enemiesIn(u.team, zz.x, zz.y, zz.r + 50, { heroes: true })) {
          if (e.kind !== 'hero' || caught.has(e.id) || segDist(e.x, e.y, ax, ay, bx, by) > e.radius + 20) continue;
          caught.add(e.id);
          const d = val(a, 'root_duration');
          root(u, e, d, a, 'sticky_snare');
          reveal(u, e, d, a);
          debuff(u, e, a, {
            name: 'sticky_snare_burn', duration: d, interval: 0.5, fx: 'root',
            onInterval(m) { damage(u, m.owner as Unit, val(a, 'damage_per_second') * 0.5, 'magical', a, { noProc: true }); },
          });
          u.w.emit({ n: 'root', x: e.x, y: e.y, u: e.id });
          // Tras saltar, la línea dura lo que la raíz.
          if (zz.until > u.w.time + d) zz.until = u.w.time + d;
        }
      },
    });
    snares.push(z);
    while (snares.length > val(a, 'count')) { const old = snares.shift()!; old.until = u.w.time; }
    a.data.snares = snares;
  },
});

// ---------------- Spider's Milk ----------------

defineAbility({
  key: 'broodmother_spiders_milk', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'spiders_milk',
    onAnyDeath(m, victim, killer) {
      const u = m.owner as Unit;
      if (killer !== u || victim.team === u.team) return;
      const per = victim.s.maxHp * val(a, 'kill_heal_heroes') / 100 * (victim.isHeroLike ? 1 : 1 - val(a, 'kill_creeps_penalty') / 100);
      for (const s of u.w.list) {
        if (!s.alive || !controlledBy(s, u) || dist(s, u) > val(a, 'kill_heal_aoe')) continue;
        s.addMod({
          name: 'spiders_milk_heal', duration: val(a, 'kill_heal_duration'), interval: val(a, 'tick_rate'), data: { multi: true },
          onInterval(mm) { heal(mm.owner as Unit, per, u, true); },
        }, u, a);
      }
    },
  }),
});

// ---------------- Spawn Spiderlings ----------------

/** Crea arañas de Broodmother en (x, y). */
function spawnSpiders(a: AbilityInst, x: number, y: number, n: number, key: 'broodmother_spiderling' | 'broodmother_spiderite', duration: number) {
  const u = a.owner as Unit;
  for (let i = 0; i < n; i++) {
    const ang = (Math.PI * 2 * i) / Math.max(1, n);
    const s = key === 'broodmother_spiderling'
      ? u.w.spawnSummon(u, spiderBase(key, val(a, 'hp_bonus'), val(a, 'damage_bonus')), x + Math.cos(ang) * 60, y + Math.sin(ang) * 60, duration, {
        name: key, abilities: ['broodmother_poison_sting', 'broodmother_spawn_spiderite'], level: a.level,
      })
      : u.w.spawnSummon(u, key, x + Math.cos(ang) * 40, y + Math.sin(ang) * 40, duration, { abilities: [] });
    summonBrain(s);
  }
}

defineAbility({
  key: 'broodmother_spawn_spiderlings', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'spawn_spiderlings', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), dodgeable: true,
      onHit() {
        debuff(u, e, a, {
          name: 'spawn_spiderlings', duration: val(a, 'buff_duration'),
          // Si muere con el debuff, nacen las arañas.
          onDeath(m) { const v = m.owner as Unit; spawnSpiders(a, v.x, v.y, val(a, 'count'), 'broodmother_spiderling', val(a, 'spiderling_duration')); },
        });
        slow(u, e, a, 'spawn_spiderlings_slow', val(a, 'slow_duration'), val(a, 'movement_speed') / 100);
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        return true;
      },
    });
  },
});

defineAbility({
  key: 'broodmother_poison_sting', target: 'passive',
  passive: (a) => ({
    name: 'poison_sting',
    onAttackLanded(_m, ev) {
      const t = ev.target as Unit;
      if (ev.missed || t.team === ev.attacker.team) return;
      slow(ev.attacker as Unit, t, a, 'poison_sting', t.isHeroLike ? val(a, 'duration_hero') : val(a, 'duration'), Math.abs(val(a, 'movement_speed')) / 100);
    },
  }),
});

defineAbility({
  key: 'broodmother_spawn_spiderite', target: 'passive',
  passive: (a) => ({
    name: 'spawn_spiderite',
    onAttackLanded(_m, ev) {
      const t = ev.target as Unit;
      if (ev.missed || t.team === ev.attacker.team) return;
      const brood = heroOf(ev.attacker as Unit);
      const ult = find(brood, 'broodmother_spawn_spiderlings');
      debuff(ev.attacker as Unit, t, a, {
        name: 'spawn_spiderite', duration: val(a, 'buff_duration'),
        onDeath(m) { if (ult && brood.alive) spawnSpiders(ult, (m.owner as Unit).x, (m.owner as Unit).y, 1, 'broodmother_spiderite', val(a, 'spiderite_duration')); },
      });
    },
  }),
});

defineHero('broodmother', ['broodmother_insatiable_hunger', 'broodmother_spin_web', 'broodmother_incapacitating_bite', 'broodmother_sticky_snare', 'broodmother_spiders_milk', 'broodmother_spawn_spiderlings'], {
  build: ['wraith_band', 'power_treads', 'orchid', 'black_king_bar', 'basher', 'assault', 'bloodthorn'],
});
