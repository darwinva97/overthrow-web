import { defineAbility, defineHero, dmg, dur, hasScepter, isItem, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { blind, helper } from './lib/a8';
import { castDir, debuff, push, root } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

defineAbility({
  key: 'tinker_laser', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.emit({ n: 'laser', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
    const targets = new Set<Unit>([e]);
    // Talento: el láser explota en área.
    const r = val(a, 'radius_explosion');
    if (r > 0) for (const v of u.w.enemiesIn(u.team, e.x, e.y, r)) if (v.kind !== 'ward') targets.add(v);
    for (const v of targets) {
      const k = v === e ? 1 : val(a, 'splash_pct') / 100;
      damage(u, v, dmg(a, 'laser_damage') * k, 'pure', a);
      blind(u, v, a, 'laser_blind', dur(a, 'duration'), val(a, 'miss_rate') / 100);
    }
  },
});

defineAbility({
  key: 'tinker_march_of_the_machines', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const [dx, dy] = castDir(u, t.x, t.y);
    const R = val(a, 'radius');
    // Los robots salen de una franja detrás de Tinker y avanzan en la dirección elegida.
    const bx = u.x - dx * R * 0.5, by = u.y - dy * R * 0.5;
    const healed = new Set<number>();
    w.emit({ n: 'march', x: u.x, y: u.y, x2: u.x + dx * val(a, 'distance'), y2: u.y + dy * val(a, 'distance'), r: R, t: u.team });
    w.addZone({
      fx: '', x: bx, y: by, r: 0, team: u.team, interval: 1 / val(a, 'machines_per_sec'), duration: dur(a, 'duration'),
      onInterval() {
        const off = (w.rng() * 2 - 1) * R;
        w.addProjectile({
          kind: 'linear', fx: 'march_robot', source: u, x: bx - dy * off, y: by + dx * off, dx, dy,
          speed: val(a, 'speed'), left: val(a, 'distance'), width: val(a, 'collision_radius') * 2,
          onHit(p, e) {
            const v = e as Unit;
            if (v.team === u.team) {
              // Scepter: los robots curan a los héroes aliados que tocan.
              if (hasScepter(u) && v.isHeroLike && !healed.has(v.id)) {
                healed.add(v.id);
                v.addMod({ name: 'march_heal', duration: val(a, 'heal_duration'), interval: 0.5, fx: 'heal',
                  onInterval(m) { heal(m.owner as Unit, val(a, 'heal_per_second') * 0.5, u, true); } }, u, a);
              }
              return false;
            }
            if (v.kind === 'ward') return false;
            for (const x of w.enemiesIn(u.team, p.x, p.y, val(a, 'splash_radius'))) damage(u, x, dmg(a, 'damage'), 'magical', a, { noProc: true });
            return true;
          },
        });
      },
    });
  },
});

/** Torreta: dispara misiles en línea al enemigo más cercano. */
function turret(u: Unit, a: AbilityInst, x: number, y: number) {
  const w = u.w;
  const tu = helper(u, 'tinker_turret1', x, y, val(a, 'turret_duration'), 0, { hp: val(a, 'turret_hp') });
  tu.addMod({
    name: 'tinker_turret', persistent: true, fx: 'turret', interval: Math.max(0.2, val(a, 'missile_spawn_interval')),
    onInterval() {
      const tgt = w.enemiesIn(u.team, tu.x, tu.y, val(a, 'missile_target_range'))
        .filter((e) => e.kind !== 'ward' && w.canSee(u.team, e))
        .sort((p, q) => (+q.isHeroLike - +p.isHeroLike) || Math.hypot(p.x - tu.x, p.y - tu.y) - Math.hypot(q.x - tu.x, q.y - tu.y))[0];
      if (!tgt) return;
      const [dx, dy] = castDir(tu, tgt.x, tgt.y);
      w.addProjectile({
        kind: 'linear', fx: 'turret_missile', source: tu, x: tu.x, y: tu.y, dx, dy,
        speed: val(a, 'missile_speed'), left: val(a, 'missile_range'), width: val(a, 'missile_width'),
        onHit(p, e) {
          const v = e as Unit;
          if (v.team === u.team || v.kind === 'ward') return false;
          for (const o of w.enemiesIn(u.team, p.x, p.y, val(a, 'radius_explosion'))) {
            damage(u, o, dmg(a, 'missile_damage') * (o === v ? 1 : val(a, 'splash_pct') / 100), 'magical', a);
          }
          return true;
        },
      });
    },
  });
}

defineAbility({
  key: 'tinker_deploy_turrets', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'drop_aoe_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const R = val(a, 'drop_aoe_radius');
    w.emit({ n: 'turret_drop', x: t.x, y: t.y, r: R, d: val(a, 'drop_delay'), t: u.team });
    w.after(val(a, 'drop_delay'), () => {
      for (const e of w.enemiesIn(u.team, t.x, t.y, R)) {
        damage(u, e, dmg(a, 'drop_damage'), 'magical', a);
        if (!e.has(ST.magicImmune)) push(e, e.x - t.x || 1, e.y - t.y, val(a, 'drop_knockback_distance'), val(a, 'drop_knockback_duration'), u, a, 'turret_knockback');
      }
      // Tinker dentro de la zona sale despedido (movilidad).
      if (u.alive && Math.hypot(u.x - t.x, u.y - t.y) <= R) {
        push(u, u.x - t.x || 1, u.y - t.y, val(a, 'drop_knockback_distance_tinker'), val(a, 'drop_knockback_duration_tinker'), u, a, 'turret_knockback');
      }
      const n = val(a, 'turrets_per_drop') + val(a, 'extra_turrets_per_drop');
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + w.rng();
        const r = val(a, 'turret_placement_radius') + w.rng() * (R - val(a, 'turret_placement_radius')) * 0.5;
        turret(u, a, t.x + Math.cos(ang) * r, t.y + Math.sin(ang) * r);
      }
    });
  },
});

defineAbility({
  key: 'tinker_warp_grenade', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'warp_flare', source: u, target: e, x: u.x, y: u.y, speed: 1500, dodgeable: true,
      onHit() {
        if (!e.alive) return true;
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        if (!e.alive || (e.has(ST.magicImmune) && !a.def.bkbPierce)) return true;
        // Más cerca de Tinker, más lejos lo manda.
        const d = Math.hypot(e.x - u.x, e.y - u.y);
        const go = Math.max(0, val(a, 'max_distance') - d) * val(a, 'warp_distance_factor');
        const [dx, dy] = d > 1 ? [(e.x - u.x) / d, (e.y - u.y) / d] : [Math.cos(u.facing), Math.sin(u.facing)];
        u.w.emit({ n: 'blink', x: e.x, y: e.y, x2: e.x + dx * go, y2: e.y + dy * go, u: e.id, c: 'warp' });
        u.w.disjoint(e);
        u.w.teleport(e, e.x + dx * go, e.y + dy * go);
        const D = val(a, 'debuff_duration');
        root(u, e, D, a, 'warp_flare_root');
        const k = val(a, 'range_reduction') / 100;
        debuff(u, e, a, { name: 'warp_flare', duration: D, fx: 'warp_flare',
          props: { attackRange: -e.s.attackRange * k, castRange: -600 * k } });
        return true;
      },
    });
  },
});

/** Keen Conveyance: nivel 1 con fuente, 2 con unidades aliadas y 3 con héroes (sube con Rearm). */
const keenLevel = (u: Unit) => Math.min(3, 1 + (ability(u, 'tinker_rearm')?.level ?? 0));

defineAbility({
  key: 'tinker_keen_teleport', target: 'point', innate: true, castBeyond: true, ai: { role: 'escape' },
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) { a.data.tx = t.x; a.data.ty = t.y; },
  onChannelEnd(a, interrupted) {
    if (interrupted) return;
    const u = a.owner as Unit;
    const w = u.w;
    const lvl = keenLevel(u);
    const f = w.teams[u.team]?.fountain;
    const spots: { x: number; y: number }[] = f ? [f] : [];
    for (const al of w.list) {
      if (al === u || al.team !== u.team || !al.alive || !w.targetable(al)) continue;
      if ((lvl >= 2 && (al.kind === 'creep' || al.kind === 'summon')) || (lvl >= 3 && al.kind === 'hero')) spots.push(al);
    }
    const tx = a.data.tx, ty = a.data.ty;
    const best = spots.sort((p, q) => Math.hypot(p.x - tx, p.y - ty) - Math.hypot(q.x - tx, q.y - ty))[0];
    if (!best) return;
    // Aterriza en el punto pedido si está cerca del destino; si no, junto a él.
    let x = tx, y = ty;
    const d = Math.hypot(tx - best.x, ty - best.y);
    const max = val(a, 'maximum_distance'), min = val(a, 'minimun_distance');
    if (d > max) { x = best.x + (tx - best.x) / d * max; y = best.y + (ty - best.y) / d * max; }
    else if (d < min) { x = best.x + min; y = best.y; }
    w.emit({ n: 'teleport', x: u.x, y: u.y, x2: x, y2: y, u: u.id });
    w.teleport(u, x, y);
    w.addVision(u.team, x, y, val(a, 'vision_radius'), 1);
  },
});

// Objetos que Rearm no reinicia (como en Dota).
const REARM_EXCLUDED = new Set([
  'aeon_disk', 'arcane_boots', 'black_king_bar', 'boots_of_bearing', 'ancient_janggo', 'guardian_greaves', 'hand_of_midas',
  'helm_of_the_dominator', 'helm_of_the_overlord', 'holy_locket', 'sphere', 'mekansm', 'meteor_hammer', 'pipe',
  'refresher', 'refresher_shard', 'pavise',
]);

defineAbility({
  key: 'tinker_rearm', target: 'none', ult: true, ai: { role: 'channel', selfRadius: 900 },
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a) { (a.owner as Unit).w.emit({ n: 'rearm', x: a.owner.x, y: a.owner.y, u: a.owner.id }); },
  onChannelEnd(a, interrupted) {
    if (interrupted) return;
    const u = a.owner as Unit;
    for (const x of u.abilities) {
      if (x === a) continue;
      x.cd = 0;
      if (x.impl.charges && x.level > 0) { x.charges = x.impl.charges(x)[0]; x.chargeCd = 0; }
    }
    // En el parche actual Rearm solo reinicia habilidades (affects_items = 0 en los datos).
    if (val(a, 'affects_items') > 0) {
      for (let s = 0; s < 6; s++) {
        const it = u.items[s];
        if (it && !REARM_EXCLUDED.has(it.key)) it.cd = 0;
      }
    }
  },
});

defineAbility({
  key: 'tinker_eureka', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'eureka',
    onAbilityExecuted(m, ab) {
      if (!isItem(ab) || ab.cd <= 0) return;
      const u = m.owner as Unit;
      const pct = Math.min(val(a, 'max_cdr'), u.s.int / val(a, 'int_per_one_cdr') * val(a, 'one_percent_tooltip')) / 100;
      ab.cd *= 1 - pct;
    },
  }),
});

defineHero('tinker', ['tinker_laser', 'tinker_march_of_the_machines', 'tinker_deploy_turrets', 'tinker_warp_grenade',
  'tinker_keen_teleport', 'tinker_rearm', 'tinker_eureka'], {
  build: ['null_talisman', 'soul_ring', 'arcane_boots', 'blink', 'kaya', 'ethereal_blade', 'sheepstick', 'shivas_guard', 'ultimate_scepter'],
});
