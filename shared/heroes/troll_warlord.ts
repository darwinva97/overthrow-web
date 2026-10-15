import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, launchAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { blind, heroOf } from './lib/a8';
import { castDir, illusionsOf, root, slow } from './util';

/** Troll en forma cuerpo a cuerpo (la base de stats es compartida con sus ilusiones). */
const isMelee = (u: Unit) => u.base.melee;

/** Efecto sobre enemigos inmunes según el talento de Whirling Axes. */
function axeDebuff(u: Unit, e: Unit, a: AbilityInst) {
  return !e.has(ST.magicImmune) || val(a, 'pierces_magic_immunity') > 0;
}

defineAbility({
  key: 'troll_warlord_switch_stance', target: 'toggle', innate: true, ai: { role: 'buff' },
  // Armadura por velocidad de ataque extra, en las dos formas.
  passive: (a) => ({
    name: 'troll_stance_armor',
    props: (m) => {
      const u = m.owner as Unit;
      const bonus = Math.max(0, (u.s?.as ?? 100) - 100);
      return { armor: Math.floor(bonus / val(a, 'attack_speed_interval')) * val(a, 'armor_per_interval') };
    },
    onTick(m) {
      const u = m.owner as Unit;
      const want = Math.floor(Math.max(0, u.s.as - 100) / val(a, 'attack_speed_interval'));
      if (want !== m.data.k) { m.data.k = want; u.refreshStats(); }
    },
  }),
  onToggle(a, on) {
    const u = heroOf(a.owner as Unit);
    const b = u.base;
    if (on && !u.data_trollRanged) {
      u.data_trollRanged = { melee: b.melee, range: b.range, bat: b.bat };
      b.melee = true;
      b.range = Math.max(150, b.range - val(a, 'bonus_range'));
      b.bat = val(a, 'base_attack_time');
    } else if (!on && u.data_trollRanged) {
      Object.assign(b, u.data_trollRanged);
      u.data_trollRanged = null;
    }
    u.atk.phase = 0;
    u.w.emit({ n: 'switch_stance', x: u.x, y: u.y, u: u.id });
    for (const x of [u, ...illusionsOf(u)]) x.refreshStats();
  },
});

defineAbility({
  key: 'troll_warlord_whirling_axes_ranged', target: 'unitOrPoint', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const base = Math.atan2(dy, dx);
    const n = val(a, 'axe_count');
    const spread = val(a, 'axe_spread') * Math.PI / 180;
    const hit = new Set<number>();
    for (let i = 0; i < n; i++) {
      const ang = base + (n > 1 ? -spread + (2 * spread * i) / (n - 1) : 0);
      u.w.addProjectile({
        kind: 'linear', fx: 'whirling_axe', source: u, x: u.x, y: u.y, dx: Math.cos(ang), dy: Math.sin(ang),
        speed: val(a, 'axe_speed'), left: val(a, 'axe_range') + u.s.castRange, width: val(a, 'axe_width'),
        onHit(_p, e) {
          const v = e as Unit;
          if (v.team === u.team || v.kind === 'ward' || hit.has(v.id) || !axeDebuff(u, v, a)) return false;
          hit.add(v.id);
          damage(u, v, dmg(a, 'axe_damage'), 'magical', a);
          v.addMod({ name: 'whirling_axes_slow', duration: dur(a, 'axe_slow_duration'), debuff: true, fx: 'slow',
            props: { msSlow: val(a, 'movement_speed') / 100 } }, u, a);
          return false;
        },
      });
    }
  },
});

defineAbility({
  key: 'troll_warlord_whirling_axes_melee', target: 'none', ai: { role: 'aoe', selfRadius: 380 },
  aoe: (a) => val(a, 'max_range'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (hasScepter(u)) u.purge(true, false);
    const D = val(a, 'whirl_duration');
    const R = val(a, 'max_range');
    const hit = new Set<number>();
    let el = 0;
    // Dos hachas giran alrededor de Troll: se alejan hasta el alcance máximo y vuelven.
    u.addMod({
      name: 'whirling_axes_melee', duration: D, fx: 'whirling_axes_melee',
      onTick(_m, dt) {
        el += dt;
        const r = R * Math.sin(Math.PI * Math.min(1, el / D));
        const h = val(a, 'hit_radius');
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, r + h)) {
          if (hit.has(e.id) || e.kind === 'ward' || Math.hypot(e.x - u.x, e.y - u.y) < r - h - e.radius || !axeDebuff(u, e, a)) continue;
          hit.add(e.id);
          damage(u, e, dmg(a, 'damage'), 'magical', a);
          blind(u, e, a, 'whirling_axes_blind', dur(a, 'blind_duration'), val(a, 'blind_pct') / 100);
        }
      },
    }, u, a);
  },
});

defineAbility({
  key: 'troll_warlord_fervor', target: 'passive',
  passive: (a) => ({
    name: 'fervor', stacks: 0, data: { target: 0 },
    props: (m) => ({ attackSpeed: m.stacks * val(a, 'attack_speed') }),
    onAttackLanded(m, ev) {
      if (ev.fake) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.id === m.data.target) m.stacks = Math.min(val(a, 'max_stacks'), m.stacks + 1);
      else { m.stacks = 0; m.data.target = t.id; }
      u.refreshStats();
      // Shard: probabilidad de un ataque extra contra otro enemigo cercano.
      if (!hasShard(u) || u.w.rng() >= (val(a, 'base_chance') + m.stacks * val(a, 'extra_attack_chance_per_stack')) / 100) return;
      const r = 500 + val(a, 'range_buffer');
      const list = u.w.enemiesIn(u.team, u.x, u.y, r).filter((e) => e.kind !== 'ward' && u.w.canSee(u.team, e));
      if (!list.length) return;
      const e = list[Math.floor(u.w.rng() * list.length)];
      launchAttack(u, e, true);
    },
  }),
});

defineAbility({
  key: 'troll_warlord_berserkers_rage', target: 'passive',
  passive: (a) => ({
    name: 'berserkers_rage', fx: 'berserkers_rage',
    props: (m) => (isMelee(m.owner as Unit) ? { msFlat: val(a, 'bonus_move_speed'), armor: val(a, 'bonus_armor') } : {}),
    onAttackLanded(_m, ev) {
      if (ev.fake) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.team === u.team || t.kind === 'ward') return;
      if (isMelee(u)) {
        if (u.w.rng() < val(a, 'ensnare_chance') / 100) root(u, t, val(a, 'ensnare_duration'), a, 'berserkers_rage_ensnare');
      } else if (u.w.rng() < val(a, 'maim_chance') / 100) {
        ev.damage += val(a, 'maim_damage');
        slow(u, t, a, 'berserkers_rage_maim', val(a, 'maim_duration'), val(a, 'maim_slow') / 100, val(a, 'maim_attack_slow'));
      }
    },
  }),
});

defineAbility({
  key: 'troll_warlord_battle_trance', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    u.purge(true, false, val(a, 'strong_dispel') > 0);
    const D = dur(a, 'trance_duration');
    const R = val(a, 'range');
    u.addMod({
      name: 'battle_trance', duration: D, fx: 'battle_trance',
      props: {
        lifesteal: val(a, 'lifesteal') / 100, attackSpeed: val(a, 'attack_speed'),
        msPct: val(a, 'movement_speed') / 100, slowResist: val(a, 'slow_resistance') / 100,
      },
      // No puede morir mientras dura.
      onIncomingDamage(_m, ev) { if (ev.amount >= u.hp) ev.amount = Math.max(0, u.hp - 1); },
      // Ataca sin remedio al enemigo más cercano, primero héroes.
      onTick() {
        const list = w.enemiesIn(u.team, u.x, u.y, R).filter((e) => e.kind !== 'ward' && w.canSee(u.team, e));
        if (!list.length) return;
        list.sort((p, q) => (+q.isHeroLike - +p.isHeroLike) || Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y));
        const o = u.order;
        if (!u.cast && (!o || o.type !== 'attack' || o.target !== list[0].id)) w.issueOrder(u, { type: 'attack', target: list[0].id });
      },
    }, u, a);
    // Talento: los aliados cercanos comparten la velocidad de ataque.
    const share = val(a, 'attack_speed_share_percent') / 100;
    if (share > 0) {
      for (const al of w.alliesIn(u.team, u.x, u.y, R, { heroes: true })) {
        if (al !== u) al.addMod({ name: 'battle_trance_share', duration: D, fx: 'battle_trance', props: { attackSpeed: val(a, 'attack_speed') * share } }, u, a);
      }
    }
  },
});

defineHero('troll_warlord', ['troll_warlord_switch_stance', 'troll_warlord_whirling_axes_ranged', 'troll_warlord_whirling_axes_melee',
  'troll_warlord_fervor', 'troll_warlord_berserkers_rage', 'troll_warlord_battle_trance'], {
  build: ['wraith_band', 'power_treads', 'sange_and_yasha', 'black_king_bar', 'basher', 'satanic', 'butterfly', 'abyssal_blade'],
});

