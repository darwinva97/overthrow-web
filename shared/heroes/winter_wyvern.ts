import { lv } from '../data';
import { defineAbility, defineHero, dmg, dur, hasScepter, maxLevel, refreshPassive, val } from '../sim/abilities';
import { creditHero, damage, heal } from '../sim/combat';
import type { AbilityInst, DamageEvent, Modifier } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botAllyTarget, dist, hurtAlly } from './lib/a9';
import { canDebuff, debuff, slow, stun } from './util';

/** Ataque de Arctic Burn: quema un % de la vida actual y ralentiza (no se renueva mientras dura). */
function burn(a: AbilityInst, u: Unit, t: Unit) {
  if (t.team === u.team || t.findMod('arctic_burn_debuff', u) || !canDebuff(u, t, a)) return;
  const tick = val(a, 'tick_rate');
  debuff(u, t, a, {
    name: 'arctic_burn_debuff', duration: dur(a, 'damage_duration'), interval: tick, fx: 'frost',
    props: { msSlow: val(a, 'move_slow') / 100 },
    onInterval(m) {
      const v = m.owner as Unit;
      damage(u, v, v.hp * val(a, 'percent_damage') / 100 * tick * a.upg.dmg, 'magical', a, { noProc: true });
    },
  });
}

defineAbility({
  key: 'winter_wyvern_arctic_burn', target: 'none', ai: { role: 'buff', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const scepter = hasScepter(u);
    const cur = u.findMod('arctic_burn', u);
    // Con Scepter es un interruptor que gasta maná por segundo.
    if (scepter) {
      a.cd = 0;
      if (cur) {
        if (!u.isBot || u.mana < u.s.maxMana * 0.2) u.removeMod(cur);
        return;
      }
    }
    u.addMod({
      name: 'arctic_burn', duration: scepter ? Infinity : dur(a, 'duration'), fx: 'arctic_burn', purgable: false,
      states: ST.flying | ST.noCollision, interval: 1,
      props: { attackRange: val(a, 'attack_range_bonus'), msPct: val(a, 'movement_scepter') / 100 },
      onAttackLanded(_m, ev) { burn(a, u, ev.target as Unit); },
      onInterval(m) {
        if (!scepter) return;
        const mc = val(a, 'mana_cost_scepter');
        if (u.mana < mc || !hasScepter(u)) { u.removeMod(m); return; }
        u.mana -= mc;
      },
      onDestroy() { u.w.cutTrees(u.x, u.y, val(a, 'tree_destruction_radius')); },
    }, u, a);
  },
});

defineAbility({
  key: 'winter_wyvern_splinter_blast', target: 'unit', team: 'any', reflectable: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'split_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const speed = Math.max(val(a, 'projectile_speed'), dist(u, e) / val(a, 'projectile_max_time'));
    u.w.addProjectile({
      kind: 'track', fx: 'splinter_blast', source: u, target: e, x: u.x, y: u.y, speed, dodgeable: true,
      onHit() {
        const r = val(a, 'split_radius');
        u.w.emit({ n: 'splinter_shatter', x: e.x, y: e.y, r, t: u.team });
        // El objetivo principal no recibe nada; las astillas golpean alrededor.
        for (const v of u.w.enemiesIn(u.team, e.x, e.y, r)) {
          if (v === e) continue;
          u.w.after(dist(v, e) / val(a, 'secondary_projectile_speed'), () => {
            if (!v.alive || !canDebuff(u, v, a)) return;
            damage(u, v, dmg(a, 'damage'), 'magical', a);
            slow(u, v, a, 'splinter_blast_slow', dur(a, 'slow_duration'), Math.abs(val(a, 'bonus_movespeed')) / 100);
            if (val(a, 'stun_duration') > 0) stun(u, v, val(a, 'stun_duration'), a);
          });
        }
        return true;
      },
    });
  },
});

defineAbility({
  key: 'winter_wyvern_cold_embrace', target: 'unit', team: 'ally', allowSelf: true, noIllusion: true, ai: { role: 'heal' },
  passive: (a) => botAllyTarget(a, (u) => hurtAlly(u, val(a, 'abilitycastrange') + u.s.castRange, 0.45)),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const tick = val(a, 'tick_interval');
    e.purge(true, false);
    if (e.cast) e.w.interruptCast(e, true);
    e.addMod({
      name: 'cold_embrace', duration: dur(a, 'duration'), fx: 'cold_embrace', interval: tick, states: ST.stunned,
      onIncomingDamage(_m, ev) { if (ev.type === 'physical' && !ev.hpRemoval) ev.amount = 0; },
      onInterval(m) {
        const v = m.owner as Unit;
        heal(v, (val(a, 'heal_additive') + v.s.maxHp * val(a, 'heal_percentage') / 100) * tick * a.upg.dmg, u, true);
      },
      onDestroy(m) {
        const v = m.owner as Unit;
        if (val(a, 'damage_buff_pct') > 0 && v.alive) {
          v.addMod({ name: 'cold_embrace_damage', duration: val(a, 'damage_buff_duration'), props: { damagePct: val(a, 'damage_buff_pct') / 100 } }, u, a);
        }
      },
    }, u, a);
    // Shard: menos enfriamiento.
    const red = val(a, 'shard_cooldown_reduction');
    if (red > 0) a.cd = Math.max(0, a.cd - red * (1 - u.s.cdr));
  },
});

defineAbility({
  key: 'winter_wyvern_eldwurms_edda', target: 'passive', innate: true, noIllusion: true,
  // Al llegar al minuto del dato se consume: +25% de Inteligencia base y un nivel más en una básica.
  passive: (a) => ({
    name: 'eldwurms_edda', interval: 1,
    onInterval(m) {
      const u = m.owner as Unit;
      if (a.data.used || u.kind !== 'hero' || u.w.time < val(a, 'tooltip_seconds')) return;
      a.data.used = true;
      u.permInt += u.baseAttr('int') * val(a, 'tooltip_int_pct') / 100;
      const basics = u.abilities.slice(0, 3).filter((x) => x.level > 0);
      basics.sort((p, q) => q.level - p.level || Number(q.slot === 1) - Number(p.slot === 1));
      const b = basics[0];
      if (b) {
        if (b.level < maxLevel(b)) b.level++;
        else {
          // Nivel extra: el siguiente valor sigue la progresión de los dos últimos (sin tocar el maná).
          for (const [k, arr] of Object.entries(b.def.values)) {
            if (k === '_mc' || arr.length < 2) continue;
            const l = arr.length;
            b.bonus[k] = (b.bonus[k] ?? 0) + (lv(arr, l) - lv(arr, l - 1)) / 2;
          }
        }
        refreshPassive(b);
      }
      u.refreshStats();
      u.w.emit({ n: 'levelup', x: u.x, y: u.y, u: u.id });
    },
  }),
});

defineAbility({
  key: 'winter_wyvern_winters_curse', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const w = u.w;
    const cursed = w.enemiesIn(u.team, e.x, e.y, val(a, 'radius'), { immune: false })
      .filter((x) => x !== e && x.team === e.team && x.kind !== 'ward' && !x.has(ST.disarmed));
    let d = val(a, 'duration');
    for (const c of cursed) d += c.isHeroLike ? val(a, 'bonus_duration_per_hero') : val(a, 'bonus_duration_per_creep');
    d = Math.min(val(a, 'max_duration'), d);
    // Solo Winter Wyvern y sus unidades pueden dañarles.
    const shield = (m: Modifier, ev: DamageEvent) => {
      const o = m.owner as Unit, src = ev.source as Unit | null;
      if (!src || src.team === o.team) return;
      if (src === u || src.owner === u || creditHero(src) === u) return;
      ev.amount *= 1 - val(a, 'damage_reduction') / 100;
    };
    e.purge(false, true);
    if (e.cast) w.interruptCast(e, true);
    w.emit({ n: 'winters_curse', x: e.x, y: e.y, r: val(a, 'radius'), d, u: e.id, t: u.team });
    e.addMod({
      name: 'winters_curse_frozen', duration: d, debuff: true, purgable: false, fx: 'frozen', states: ST.stunned,
      onIncomingDamage: shield,
      onDestroy() { for (const c of cursed) { c.removeModsByName('taunt'); c.removeModsByName('winters_curse'); } },
    }, u, a);
    for (const c of cursed) {
      c.order = null; c.atk.phase = 0;
      if (c.cast) w.interruptCast(c, true);
      c.addMod({ name: 'taunt', duration: d, debuff: true, purgable: false, states: ST.taunted | ST.silenced | ST.muted }, e, a);
      c.addMod({
        name: 'winters_curse', duration: d, debuff: true, purgable: false, fx: 'winters_curse',
        props: { attackSpeed: val(a, 'bonus_attack_speed') },
        onIncomingDamage: shield,
      }, u, a);
    }
  },
});

defineHero('winter_wyvern', ['winter_wyvern_arctic_burn', 'winter_wyvern_splinter_blast', 'winter_wyvern_cold_embrace', 'winter_wyvern_eldwurms_edda', 'winter_wyvern_winters_curse'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'ultimate_scepter', 'sheepstick', 'refresher'],
});
