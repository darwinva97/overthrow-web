// Lone Druid: Entangle, Spirit Link, Savage Roar, Summon Spirit Bear (innata) y True Form.
// El oso es una invocación controlable con sus propias habilidades, que siguen el nivel de las del druida.
import { HEROES, UNITS } from '../data';
import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, refreshPassive, val } from '../sim/abilities';
import { damage, heal, kill } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import { ATTR, type BaseStats, type Unit } from '../sim/unit';
import { botBrain, currentTarget, nearestEnemyHero, ready, summonFollow } from './lib/a4';
import { debuff } from './util';

const BEAR = 'lone_druid_bear1';

/** Druida dueño (si `u` es el oso, su dueño). */
const druidOf = (u: Unit): Unit => (u.kind === 'summon' && u.owner ? u.owner as Unit : u);
const abil = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Oso vivo del druida, si lo hay. */
function bearOf(druid: Unit): Unit | null {
  const id = druid.data_bear as number | undefined;
  const b = id ? druid.w.units.get(id) : undefined;
  return b && b.alive ? b : null;
}

/** Número de un talento sin enlace de valor, sacado de su nombre ("-25s Summon…"). */
function talentNumber(key: string): number {
  const t = HEROES.lone_druid.talents.find((x) => x.key === key);
  const n = t ? parseFloat(t.name.replace(/[^\d.]+/, '')) : 0;
  return Number.isFinite(n) ? n : 0;
}

// ---------------- Entangle (marcas compartidas entre druida y oso) ----------------

/**
 * Suma marcas de Entangle a `t`. Al llegar a hits_required queda enraizado y recibe daño por segundo.
 * `a` es la habilidad que aporta los valores (la del druida o la del oso).
 */
function addEntangle(druid: Unit, t: Unit, n: number, a: AbilityInst) {
  if (!t.alive || t.team === druid.team || t.kind === 'ward') return;
  const main = abil(druid, 'lone_druid_entangle');
  // Sin Scepter, un enemigo enraizado no gana marcas.
  const protect = main ? val(main, 'nostack_protection') > 0 : true;
  if (protect && t.findMod('ld_entangle_root', druid)) return;
  let m = t.findMod('ld_entangle_stacks', druid);
  const d = val(a, 'counter_duration');
  if (!m) {
    m = debuff(druid, t, a, { name: 'ld_entangle_stacks', duration: d, stacks: 0, fx: 'entangle_stacks' }) ?? undefined;
    if (!m) return;
  }
  m.stacks += n;
  m.remaining = Math.max(m.remaining, d);
  if (m.stacks < val(a, 'hits_required')) return;
  t.removeMod(m);
  const tick = 0.5;
  debuff(druid, t, a, {
    name: 'ld_entangle_root', duration: dur(a, 'entangle_duration'), states: ST.rooted, fx: 'entangle', interval: tick,
    onInterval(mm) { damage(druid, mm.owner as Unit, dmg(a, 'damage') * tick, 'magical', a, { noProc: true }); },
  });
  druid.w.emit({ n: 'entangle', x: t.x, y: t.y, u: t.id, t: druid.team });
}

defineAbility({
  key: 'lone_druid_entangle', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'active_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'active_radius');
    u.w.emit({ n: 'entangle_cast', x: t.x, y: t.y, r, t: u.team });
    const heroStacks = val(a, 'root_heroes_on_cast') > 0 ? val(a, 'hits_required') : val(a, 'hits_incremented_on_active');
    for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
      addEntangle(u, e, e.isHeroLike ? heroStacks : val(a, 'hits_required'), a);
    }
    // El druida queda potenciado: sus ataques a héroes suman marcas.
    u.addMod({
      name: 'ld_entangle_empower', duration: dur(a, 'lone_druid_buff_duration'), fx: 'entangle_empower',
      onAttackLanded(_m, ev) {
        if (ev.target.isHeroLike) addEntangle(u, ev.target as Unit, val(a, 'lone_druid_counters_applied_tooltip'), a);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'lone_druid_spirit_bear_entangle', target: 'passive',
  passive: (a) => ({
    name: 'bear_entangling_claws',
    onAttackLanded(_m, ev) {
      if (!ev.target.isHeroLike || ev.missed) return;
      const bear = a.owner as Unit;
      addEntangle(druidOf(bear), ev.target as Unit, val(a, 'spirit_bear_counters_applied_tooltip'), a);
    },
  }),
});

// ---------------- Spirit Link ----------------

/** Comparte con `partner` parte del robo de vida de los ataques del dueño. */
function linkSpec(a: AbilityInst, msKey: string, partner: (u: Unit) => Unit | null): ModSpec {
  return {
    name: 'spirit_link',
    props: { msFlat: val(a, msKey) },
    onDealDamage(m, ev) {
      const u = m.owner as Unit;
      if (!ev.isAttack || ev.noProc || u.s.lifesteal <= 0) return;
      const p = partner(u);
      if (!p || !p.alive) return;
      const creep = ev.target.kind === 'creep' ? 1 - val(a, 'creep_lifesteal_penalty') / 100 : 1;
      heal(p, ev.amount * u.s.lifesteal * val(a, 'lifesteal_percent') / 100 * creep, u, true);
    },
  };
}

defineAbility({
  key: 'lone_druid_spirit_link', target: 'passive', noIllusion: true,
  passive: (a) => linkSpec(a, 'bonus_movement_speed_druid', (u) => bearOf(u)),
});

defineAbility({
  key: 'lone_druid_spirit_bear_spirit_link', target: 'passive',
  passive: (a) => linkSpec(a, 'bonus_movement_speed_bear', (u) => (u.owner as Unit | null)),
});

// ---------------- Savage Roar ----------------

/** Miedo: huye hacia su fuente sin obedecer órdenes. */
function fear(caster: Unit, t: Unit, a: AbilityInst, d: number) {
  const m = debuff(caster, t, a, {
    name: 'savage_roar_fear', duration: d, fx: 'fear',
    states: ST.busy | ST.silenced | ST.muted | ST.disarmed,
    onTick(mm, dt) {
      const v = mm.owner as Unit;
      const f = v.w.teams[v.team]?.fountain;
      if (f) v.w.moveToward(v, f.x, f.y, dt);
    },
  });
  if (!m) return;
  t.order = null; t.queue = []; t.atk.phase = 0;
  if (t.cast) t.w.interruptCast(t, true);
}

/** Rugido desde `src` (druida u oso) con los valores de `a`. */
function roar(src: Unit, a: AbilityInst) {
  const w = src.w;
  const r = val(a, 'radius');
  const d = dur(a, 'duration');
  w.emit({ n: 'savage_roar', x: src.x, y: src.y, r, u: src.id, t: src.team });
  for (const e of w.enemiesIn(src.team, src.x, src.y, r)) {
    // Solo unidades de jugador: héroes, ilusiones e invocaciones (no creeps neutrales).
    if (!e.isHeroLike && !(e.kind === 'summon' && e.playerId)) continue;
    fear(src, e, a, d);
  }
  src.addMod({ name: 'savage_roar_speed', duration: d, props: { msPct: val(a, 'bonus_speed') / 100 } }, src, a);
  // Shard: disipación básica y aceleración de aliados cercanos (los valores están en la del druida).
  const druid = druidOf(src);
  const main = abil(druid, 'lone_druid_savage_roar');
  if (!main || !hasShard(druid)) return;
  src.purge(true, false);
  for (const al of w.alliesIn(src.team, src.x, src.y, val(main, 'shard_radius'))) {
    al.addMod({
      name: 'savage_roar_shard', duration: val(main, 'shard_duration'), fx: 'haste',
      props: { msPct: val(main, 'shard_movement_speed_pct') / 100, attackSpeed: val(main, 'shard_attack_speed') },
    }, src, main);
  }
}

defineAbility({
  key: 'lone_druid_savage_roar', target: 'none', ai: { role: 'disable', selfRadius: 320 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    roar(u, a);
    // Con Shard se replica en el oso aunque él no pueda lanzarlo.
    const bear = bearOf(u);
    const ba = bear && abil(bear, 'lone_druid_savage_roar_bear');
    if (hasShard(u) && bear && ba && ba.level > 0) roar(bear, ba);
  },
});

defineAbility({
  key: 'lone_druid_savage_roar_bear', target: 'none', ai: { role: 'disable', selfRadius: 320 },
  onSpellStart(a) {
    const bear = a.owner as Unit;
    roar(bear, a);
    const druid = druidOf(bear);
    const da = abil(druid, 'lone_druid_savage_roar');
    if (hasShard(druid) && druid.alive && da && da.level > 0) roar(druid, da);
  },
});

// ---------------- Summon Spirit Bear ----------------

/** Stats del oso a partir de units.json con los valores de la habilidad. */
function bearBase(a: AbilityInst): BaseStats {
  const d = UNITS[BEAR];
  return {
    hp: val(a, 'bear_hp') + val(a, 'bonus_bear_hp'), hpRegen: val(a, 'bear_regen_tooltip'),
    mana: d.mana, manaRegen: d.manaRegen,
    armor: val(a, 'bear_armor') + val(a, 'bonus_bear_armor'), mr: val(a, 'bear_magic_resistance'),
    dmgMin: d.dmgMin, dmgMax: d.dmgMax, bat: val(a, 'bear_bat'), attackPoint: d.attackPoint,
    range: d.range, projSpeed: d.projSpeed, ms: val(a, 'bear_movespeed'),
    dayVision: d.dayVision, nightVision: d.nightVision, turnRate: d.turnRate || 0.6, melee: true,
  };
}

/** Nivel que debe tener cada habilidad del oso según las del druida. */
function syncBear(druid: Unit, bear: Unit) {
  bear.talents = druid.talents;
  bear.shard = druid.shard;
  bear.blessing = hasScepter(druid);
  const lvl: Record<string, number> = {
    lone_druid_spirit_bear_entangle: abil(druid, 'lone_druid_entangle')?.level ?? 0,
    lone_druid_spirit_bear_spirit_link: abil(druid, 'lone_druid_spirit_link')?.level ?? 0,
    lone_druid_savage_roar_bear: abil(druid, 'lone_druid_savage_roar')?.level ?? 0,
    lone_druid_spirit_bear_fetch: hasShard(druid) ? 1 : 0,
    lone_druid_spirit_bear_return: 1,
    lone_druid_spirit_bear_demolish: 1,
  };
  for (const ba of bear.abilities) {
    const want = lvl[ba.key] ?? 1;
    if (ba.level !== want) { ba.level = want; refreshPassive(ba); }
  }
  if (bear.data_lvl !== druid.level) { bear.data_lvl = druid.level; bear.refreshStats(); }
}

/** IA del oso de un bot: sigue al objetivo del dueño, ruge, vuelve y (con Shard) arrastra. */
function bearBrain(bear: Unit): ModSpec {
  return {
    name: 'bear_brain', persistent: true,
    onTick(m, dt) {
      m.data.t = (m.data.t ?? 0) - dt;
      if (m.data.t > 0) return;
      m.data.t = 0.3;
      const druid = bear.owner as Unit | null;
      if (!druid || !druid.isBot || !bear.alive || bear.cast || bear.has(ST.busy)) return;
      const w = bear.w;
      const cast = (key: string, target?: Unit) => {
        const ba = abil(bear, key);
        if (!ba || ba.level <= 0 || !ready(ba)) return false;
        w.issueOrder(bear, { type: 'cast', slot: ba.slot, target: target?.id });
        return true;
      };
      const roarA = abil(bear, 'lone_druid_savage_roar_bear');
      const e = nearestEnemyHero(bear, roarA && roarA.level > 0 ? val(roarA, 'radius') : 0);
      if (e && bear.hp < bear.s.maxHp * 0.8 && cast('lone_druid_savage_roar_bear')) return;
      const t = druid.alive ? currentTarget(druid) : null;
      const fetchA = abil(bear, 'lone_druid_spirit_bear_fetch');
      if (t && t.kind === 'hero' && fetchA && fetchA.level > 0 && Math.hypot(t.x - bear.x, t.y - bear.y) < val(fetchA, 'abilitycastrange') + 150 &&
        Math.hypot(druid.x - bear.x, druid.y - bear.y) < 1200 && cast('lone_druid_spirit_bear_fetch', t)) return;
      const sb = abil(druid, 'lone_druid_spirit_bear');
      const leash = sb ? val(sb, 'bear_attack_leash_range') : 0;
      if (druid.alive && !t && Math.hypot(druid.x - bear.x, druid.y - bear.y) > leash * 1.8) cast('lone_druid_spirit_bear_return');
    },
  };
}

function summonBear(a: AbilityInst) {
  const u = a.owner as Unit;
  const w = u.w;
  const x = u.x + Math.cos(u.facing) * 150, y = u.y + Math.sin(u.facing) * 150;
  const old = bearOf(u);
  // Si el oso vive, se recoloca junto al druida con la vida al máximo.
  if (old) {
    w.teleport(old, x, y);
    old.hp = old.s.maxHp;
    old.order = null;
    w.emit({ n: 'bear_summon', x: old.x, y: old.y, u: old.id, t: u.team });
    return;
  }
  const d = UNITS[BEAR];
  const bear = w.spawnSummon(u, bearBase(a), x, y, Infinity, {
    name: BEAR, abilities: d.abilities, bounty: d.bountyGold, xp: d.bountyXp,
  });
  u.data_bear = bear.id;
  // Crece con el nivel del druida (atributos por nivel de los valores).
  bear.addMod({
    name: 'spirit_bear_growth', persistent: true,
    props: () => {
      const L = Math.max(0, u.level - 1);
      const str = val(a, 'strength_gain_tooltip') * L, agi = val(a, 'agility_gain_tooltip') * L, int = val(a, 'intelligence_gain_tooltip') * L;
      return {
        hp: str * ATTR.hpPerStr + val(a, 'hp_gain_per_druid_level') * L,
        hpRegen: str * ATTR.hpRegenPerStr,
        armor: agi * ATTR.armorPerAgi,
        attackSpeed: agi * ATTR.asPerAgi,
        mana: int * ATTR.manaPerInt,
        // Aproximación: el oso usa la fuerza como atributo principal para el daño.
        damage: str + val(a, 'damage_gain_per_druid_level') * L,
      };
    },
  }, u, a);
  // Correa: lejos del druida no puede atacar.
  bear.addMod({
    name: 'spirit_bear_leash', persistent: true, states: 0,
    onTick(m) {
      const far = u.alive && Math.hypot(u.x - bear.x, u.y - bear.y) > val(a, 'bear_attack_leash_range');
      const want = far ? ST.disarmed : 0;
      if (m.states !== want) { m.states = want; bear.refreshStats(); }
    },
    onDeath() {
      if (u.data_bear === bear.id) u.data_bear = 0;
      if (bear.data_noBacklash) return;
      // El enfriamiento de la invocación empieza al morir el oso; contragolpe sobre el druida.
      a.cd = Math.max(a.cd, cooldownOf(a));
      if (u.alive) {
        damage(bear, u, u.s.maxHp * val(a, 'backlash_damage') / 100, 'pure', a, { noProc: true });
      }
    },
  }, u, a);
  syncBear(u, bear);
  bear.refreshStats();
  bear.hp = bear.s.maxHp; bear.mana = bear.s.maxMana;
  bear.addMod(summonFollow(bear, 700), u, a);
  bear.addMod(bearBrain(bear), u, a);
  w.emit({ n: 'bear_summon', x: bear.x, y: bear.y, u: bear.id, t: u.team });
}

defineAbility({
  key: 'lone_druid_spirit_bear', target: 'none', innate: true, noIllusion: true,
  passive: (a) => {
    // Los bots invocan el oso en cuanto no lo tienen.
    const brain = botBrain(a, (u) => (bearOf(u) ? null : { x: u.x, y: u.y }), 0.5);
    return {
      ...brain,
      name: 'spirit_bear_control',
      onTick(m, dt) {
        brain.onTick!(m, dt);
        const u = m.owner as Unit;
        const bear = bearOf(u);
        if (bear) syncBear(u, bear);
      },
      onDeath(m) {
        // El oso muere con el druida (sin contragolpe).
        const bear = bearOf(m.owner as Unit);
        if (bear) { bear.data_noBacklash = true; kill(bear, null); }
      },
    };
  },
  onSpellStart(a) { summonBear(a); },
});

// ---------------- Habilidades propias del oso ----------------

defineAbility({
  key: 'lone_druid_spirit_bear_return', target: 'none',
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a) {
    const bear = a.owner as Unit;
    bear.w.emit({ n: 'bear_return', x: bear.x, y: bear.y, u: bear.id, t: bear.team });
  },
  onChannelEnd(a, interrupted) {
    const bear = a.owner as Unit;
    const druid = bear.owner as Unit | null;
    if (interrupted || !druid || !druid.alive || !bear.alive) return;
    bear.w.teleport(bear, druid.x + Math.cos(druid.facing + Math.PI) * 120, druid.y + Math.sin(druid.facing + Math.PI) * 120);
    bear.order = null;
    bear.w.emit({ n: 'blink', x: bear.x, y: bear.y, u: bear.id });
  },
});

defineAbility({
  key: 'lone_druid_spirit_bear_fetch', target: 'unit', team: 'any',
  onSpellStart(a, t) {
    const bear = a.owner as Unit;
    const e = t.unit as Unit;
    const druid = bear.owner as Unit | null;
    if (!druid || !e) return;
    const enemy = e.team !== bear.team;
    const tick = val(a, 'tick_rate');
    const d = val(a, 'duration');
    const hold = enemy
      ? debuff(bear, e, a, { name: 'bear_fetch', duration: d, states: ST.rooted, fx: 'fetch' })
      : e.addMod({ name: 'bear_fetch', duration: d, states: ST.rooted, fx: 'fetch' }, bear, a);
    if (!hold) return;
    if (e.cast) e.w.interruptCast(e, true);
    bear.addMod({
      name: 'bear_fetching', duration: d, states: ST.busy, interval: tick,
      onTick(m, dt) {
        const w = bear.w;
        if (!e.alive || !e.findMod('bear_fetch', bear) || Math.hypot(e.x - bear.x, e.y - bear.y) > val(a, 'break_distance')) {
          bear.removeMod(m); return;
        }
        // Arrastra al objetivo hacia el druida, a drag_distance detrás del oso.
        if (druid.alive && w.moveToward(bear, druid.x, druid.y, dt, 150)) { bear.removeMod(m); return; }
        const dx = bear.x - druid.x, dy = bear.y - druid.y;
        const l = Math.hypot(dx, dy) || 1;
        const drag = val(a, 'drag_distance');
        w.forceMove(e, bear.x + dx / l * drag, bear.y + dy / l * drag);
      },
      onInterval() {
        if (enemy && e.alive) damage(bear, e, dmg(a, 'damage') * tick / d, 'magical', a);
      },
      onDestroy() { e.removeModsByName('bear_fetch'); },
    }, bear, a);
  },
});

defineAbility({
  key: 'lone_druid_spirit_bear_demolish', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'bear_demolish',
    onAttackStart(_m, ev) {
      // En Overthrow no hay edificios: solo cuenta el talento contra enraizados.
      const bonus = val(a, 'bonus_damage_against_entangled');
      if (bonus > 0 && ev.target.mods.some((m) => m.name === 'ld_entangle_root')) ev.damage *= 1 + bonus / 100;
    },
  }),
});

// ---------------- True Form ----------------

defineAbility({
  key: 'lone_druid_true_form', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.removeModsByName('true_form');
    u.w.emit({ n: 'true_form', x: u.x, y: u.y, u: u.id, t: u.team });
    // Transformación: no actúa mientras dura.
    u.addMod({
      name: 'true_form_transform', duration: val(a, 'transformation_time'), states: ST.busy, fx: 'transform',
      onDestroy() {
        if (!u.alive) return;
        const bear = UNITS[BEAR];
        u.addMod({
          name: 'true_form', duration: dur(a, 'duration'), fx: 'true_form',
          props: {
            armor: val(a, 'bonus_armor'), hp: val(a, 'bonus_hp'), damage: dmg(a, 'bonus_attack_damage'),
            slowResist: val(a, 'bonus_slow_resistance') / 100, attackSpeed: val(a, 'attack_speed_pct'),
          },
          // Pierde el ataque a distancia: cuerpo a cuerpo con el alcance del oso.
          onCreated(m) {
            m.data.melee = u.base.melee; m.data.range = u.base.range;
            u.base = { ...u.base, melee: true, range: bear.range };
            u.refreshStats();
          },
          onDestroy(m) {
            u.base = { ...u.base, melee: m.data.melee, range: m.data.range };
            u.refreshStats();
          },
        }, u, a);
      },
    }, u, a);
  },
});

defineHero('lone_druid', ['lone_druid_entangle', 'lone_druid_spirit_link', 'lone_druid_savage_roar', 'lone_druid_spirit_bear', 'lone_druid_true_form'], {
  build: ['wraith_band', 'power_treads', 'maelstrom', 'black_king_bar', 'assault', 'mjollnir', 'satanic'],
  talents: {
    // -25 s de enfriamiento de Summon Spirit Bear (no tiene enlace de valor).
    special_bonus_unique_lone_druid_2: (u) => {
      const a = abil(u, 'lone_druid_spirit_bear');
      if (a) a.bonus._cd = (a.bonus._cd ?? 0) - talentNumber('special_bonus_unique_lone_druid_2');
    },
  },
});
