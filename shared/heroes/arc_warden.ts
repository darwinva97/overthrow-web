import { defineAbility, defineHero, dmg, dur, makeAbility, refreshPassive, syncAutoLevels, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import { syncItemPassives } from '../sim/items';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, silence, slow } from './util';
import { blindRoll, botOnly, dist, enemyHeroes, summonBrain } from './lib/a1';

defineAbility({
  key: 'arc_warden_flux', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const every = val(a, 'think_interval');
    // Solo hace efecto si no hay otra unidad aliada del objetivo cerca.
    const alone = (v: Unit) => !v.w.unitsIn(v.x, v.y, val(a, 'search_radius'), (o) => o !== v && o.team === v.team && v.w.targetable(o) &&
      (o.isHeroLike || o.kind === 'creep' || o.kind === 'summon')).length;
    debuff(u, e, a, {
      name: 'flux', duration: dur(a, 'duration'), interval: every, fx: 'static_charge',
      props: (m) => (m.data.alone ? { msSlow: val(a, 'move_speed_slow_pct') / 100 } : {}),
      onCreated(m) { m.data.alone = alone(e); },
      onInterval(m) {
        const v = m.owner as Unit;
        const was = m.data.alone;
        m.data.alone = alone(v);
        if (was !== m.data.alone) v.refreshStats();
        if (!m.data.alone) return;
        damage(u, v, dmg(a, 'damage_per_second') * every, 'magical', a, { noProc: true });
        if (val(a, 'applies_silence') > 0) silence(u, v, every + 0.05, a, 'flux_silence');
      },
    });
  },
});

defineAbility({
  key: 'arc_warden_magnetic_field', target: 'point', allowSelf: true,
  aoe: (a) => val(a, 'radius'),
  // Bots: sobre sí mismos al entrar en pelea.
  passive: (a) => botOnly(a, (u) => (enemyHeroes(u, 700).length ? { x: u.x, y: u.y } : null)),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.addZone({
      fx: 'magnetic_field', x: t.x, y: t.y, r, team: u.team, interval: 0.1, duration: dur(a, 'duration'),
      onInterval(z) {
        for (const al of u.w.alliesIn(u.team, z.x, z.y, z.r)) {
          al.addMod({
            name: 'magnetic_field', duration: 0.2, fx: 'haste',
            props: { attackSpeed: val(a, 'attack_speed_bonus') },
            // Esquiva los ataques que vienen de fuera del campo (el motor solo tiene evasión global:
            // se anula el daño del golpe).
            onIncomingDamage(_m, ev) {
              const s = ev.source as Unit | null;
              if (!ev.isAttack || !s || dist(s, z) <= z.r || u.w.rng() >= val(a, 'evasion_chance') / 100) return;
              ev.amount = 0;
              u.w.emit({ n: 'miss', x: al.x, y: al.y, u: al.id });
            },
          }, u, a);
        }
      },
    });
  },
});

defineAbility({
  key: 'arc_warden_spark_wraith', target: 'point', ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const born = u.w.time + val(a, 'base_activation_delay');
    let done = false;
    u.w.addVision(u.team, t.x, t.y, val(a, 'wraith_vision_radius'), val(a, 'wraith_vision_duration'));
    const z = u.w.addZone({
      fx: 'spark_wraith', x: t.x, y: t.y, r, team: u.team, interval: val(a, 'think_interval'), duration: dur(a, 'duration') + val(a, 'base_activation_delay'),
      onInterval() {
        if (done || u.w.time < born) return;
        const list = u.w.enemiesIn(u.team, z.x, z.y, r).filter((e) => e.kind !== 'ward' && u.w.canSee(u.team, e));
        list.sort((x, y) => (Number(y.isHeroLike) - Number(x.isHeroLike)) || dist(x, z) - dist(y, z));
        const e = list[0];
        if (!e) return;
        done = true;
        z.until = u.w.time;
        u.w.addProjectile({
          kind: 'track', fx: 'spark_wraith', source: u, target: e, x: z.x, y: z.y, speed: val(a, 'wraith_speed_base'),
          onHit() {
            damage(u, e, dmg(a, 'spark_damage_base'), 'magical', a);
            slow(u, e, a, 'spark_wraith', val(a, 'ministun_duration'), val(a, 'move_speed_slow_pct') / 100);
            u.w.addVision(u.team, e.x, e.y, val(a, 'wraith_vision_radius'), val(a, 'wraith_vision_duration'));
            return true;
          },
        });
      },
    });
  },
});

// Innata: en Overthrow no hay runas de poder, así que no tiene nada que sumar.
defineAbility({ key: 'arc_warden_runic_infusion', target: 'passive', innate: true });

const NO_COPY = /^(rapier|gem|aegis|cheese|refresher_shard|tango|flask|clarity|enchanted_mango|faerie_fire|smoke_of_deceit|dust|ward_|tpscroll|bottle|tome_)/;

/** Tempest Double: copia controlable con sus habilidades e items, con enfriamientos propios. */
function tempestDouble(src: Unit, x: number, y: number, duration: number, bounty: number) {
  const w = src.w;
  const td = w.spawnSummon(src, { ...src.base }, x, y, duration, { name: src.name, abilities: [], bounty, xp: 0 });
  td.hero = src.hero;
  td.level = src.level; td.xp = src.xp;
  td.permStr = src.permStr; td.permAgi = src.permAgi; td.permInt = src.permInt;
  td.talents = new Set(src.talents);
  td.shard = src.shard; td.blessing = src.blessing;
  td.radius = src.radius;
  td.facing = src.facing;
  td.isBot = src.isBot;
  for (const m of src.mods) if (m.name === 'talents' || m.name === 'orb_bonus') td.addMod({ ...m, name: m.name, data: { ...m.data } } as any, td, null);
  for (const a of src.abilities) {
    const c = makeAbility(td, a.key, a.slot);
    if (!c) continue;
    c.level = a.level; c.upg = { ...a.upg }; c.bonus = { ...a.bonus }; c.mult = { ...a.mult };
    c.charges = a.impl.charges && a.level > 0 ? a.impl.charges(a)[0] : 0;
    // La copia no puede lanzar otra copia.
    if (a.key === 'arc_warden_tempest_double') c.cd = 1e9;
    td.abilities.push(c);
  }
  syncAutoLevels(td);
  for (const a of td.abilities) refreshPassive(a);
  for (const s of [0, 1, 2, 3, 4, 5, 9]) {
    const it = src.items[s];
    if (!it || NO_COPY.test(it.key) || it.impl?.consumable) continue;
    td.items[s] = { ...it, owner: td, passiveMod: null, cd: 0, data: {} };
  }
  syncItemPassives(td);
  td.refreshStats();
  td.hp = td.s.maxHp; td.mana = td.s.maxMana;
  return td;
}

defineAbility({
  key: 'arc_warden_tempest_double', target: 'point', ult: true, ai: { role: 'buff' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    if (u.kind !== 'hero') return;
    for (const old of u.w.list) if (old.alive && old.owner === u && old.findMod('tempest_double')) old.expireAt = u.w.time;
    const duration = dur(a, 'duration');
    const td = tempestDouble(u, t.x, t.y, duration, val(a, 'bounty'));
    const start = u.w.time;
    // Se desintegra con el tiempo: más lenta y con más fallos.
    td.addMod({
      name: 'tempest_double', persistent: true, interval: 0.5,
      props: () => (val(a, 'has_debuff') > 0 ? { msSlow: val(a, 'max_slow') / 100 * Math.min(1, (u.w.time - start) / duration) } : {}),
      onInterval(m) { (m.owner as Unit).refreshStats(); },
      onAttackStart(_m, ev) { blindRoll(ev, val(a, 'max_blind_chance') / 100 * Math.min(1, (u.w.time - start) / duration)); },
    }, u, a);
    // Shard: runas de Arcano, Invisibilidad y Prisa al aparecer.
    const rd = val(a, 'rune_duration');
    if (rd > 0) {
      if (val(a, 'arcane_rune') > 0) td.addMod({ name: 'rune_arcane', duration: rd, fx: 'arcane_boots', props: { cdr: 0.3, manaReduce: 0.3 } }, td, a);
      if (val(a, 'haste_rune') > 0) td.addMod({ name: 'rune_haste', duration: rd, fx: 'haste', props: { msFixed: 550 } }, td, a);
      if (val(a, 'invis_rune') > 0) td.addMod({ name: 'rune_invis', duration: rd, fx: 'invis', states: ST.invisible, data: { breaksOnAttack: true } }, td, a);
    }
    u.w.emit({ n: 'blink', x: td.x, y: td.y, u: td.id, c: 'arc' });
    summonBrain(td);
    if (!u.isBot && u.order?.type === 'attack') u.w.issueOrder(td, { type: 'attack', target: u.order.target });
  },
});

defineHero('arc_warden', ['arc_warden_flux', 'arc_warden_magnetic_field', 'arc_warden_spark_wraith', 'arc_warden_runic_infusion', 'arc_warden_tempest_double'], {
  build: ['wraith_band', 'power_treads', 'hand_of_midas', 'maelstrom', 'manta', 'mjollnir', 'black_king_bar', 'bloodthorn'],
});
