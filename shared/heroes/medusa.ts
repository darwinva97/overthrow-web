import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, isItem, val } from '../sim/abilities';
import { dealDamage, damage, giveMana, burnMana, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, root, slow, stun } from './util';

defineAbility({
  key: 'medusa_split_shot', target: 'toggle', ai: { role: 'aoe', selfRadius: 700 },
  passive: (a) => ({
    name: 'split_shot',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit;
      if (ev.fake || !a.toggled) return;
      const range = u.s.attackRange + val(a, 'split_shot_bonus_range');
      const extra = u.w.enemiesIn(u.team, u.x, u.y, range)
        .filter((e) => e !== ev.target && e.kind !== 'ward' && u.w.canSee(u.team, e))
        .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))
        .slice(0, val(a, 'arrow_count') - 1);
      const mult = 1 + val(a, 'damage_modifier') / 100;
      // Con Scepter las flechas extra aplican efectos de ataque.
      const procs = val(a, 'process_procs') > 0;
      for (const e of extra) {
        const sec = procs ? makeAttack(u, e, true) : null;
        const base = u.s.dmgMin + u.w.rng() * (u.s.dmgMax - u.s.dmgMin) + u.s.dmgBonus;
        u.w.addProjectile({
          kind: 'track', fx: 'attack:medusa', source: u, target: e, x: u.x, y: u.y,
          speed: u.base.projSpeed, dodgeable: true,
          onHit() {
            if (sec) { sec.damage *= mult; landAttack(sec); return true; }
            if (u.w.rng() >= e.s.evasion) {
              dealDamage({ source: u, target: e, amount: base * mult, type: 'physical', ability: null, isAttack: true });
            }
            return true;
          },
        });
      }
    },
  }),
});

/** Serpiente mística: rebota entre enemigos y vuelve con el maná robado. */
function launchSnake(u: Unit, a: AbilityInst, first: Unit, opts: { jumps: number; stone: number; stoneInc: number }) {
  const hit = new Set<number>();
  let mana = 0;
  let jumps = 0;
  let speed = val(a, 'initial_speed');
  const scale = val(a, 'snake_scale') / 100;
  const go = (fromX: number, fromY: number, t: Unit) => {
    u.w.addProjectile({
      kind: 'track', fx: 'mystic_snake', source: u, target: t, x: fromX, y: fromY, speed, dodgeable: false,
      onHit() {
        hit.add(t.id);
        const mult = 1 + scale * jumps;
        if (t.team !== u.team) {
          damage(u, t, dmg(a, 'snake_damage') * mult, 'magical', a);
          if (t.isHeroLike || t.kind === 'creep') {
            const steal = t.s.maxMana * val(a, 'snake_mana_steal') / 100;
            mana += burnMana(t, steal);
          }
          slow(u, t, a, 'snake_slow', Math.max(0.5, val(a, 'slow_duration')), val(a, 'movement_slow') / 100);
          if (opts.stone > 0) {
            const d = opts.stone + opts.stoneInc * jumps;
            const sm = stun(u, t, d, a);
            if (sm) sm.fx = 'stone';
          }
        }
        jumps++;
        const next = jumps < opts.jumps
          ? u.w.enemiesIn(u.team, t.x, t.y, val(a, 'radius'))
            .filter((e) => !hit.has(e.id) && e.kind !== 'ward' && u.w.canSee(u.team, e))
            .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || Math.hypot(p.x - t.x, p.y - t.y) - Math.hypot(q.x - t.x, q.y - t.y))[0]
          : null;
        speed *= 1 + scale;
        if (next) {
          u.w.after(val(a, 'jump_delay'), () => { if (next.alive) go(t.x, t.y, next); else back(t.x, t.y); });
        } else back(t.x, t.y);
        return true;
      },
    });
  };
  const back = (x: number, y: number) => {
    if (mana <= 0 || !u.alive) return;
    u.w.addProjectile({
      kind: 'track', fx: 'mystic_snake_return', source: u, target: u, x, y, speed: val(a, 'return_speed'),
      onHit() { giveMana(u, mana); return true; },
    });
  };
  go(u.x, u.y, first);
}

defineAbility({
  key: 'medusa_mystic_snake', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    launchSnake(u, a, t.unit as Unit, {
      jumps: val(a, 'snake_jumps'),
      stone: hasShard(u) ? val(a, 'stone_form_scepter_base') : 0,
      stoneInc: hasScepter(u) && hasShard(u) ? val(a, 'stone_form_scepter_increment') : 0,
    });
  },
});

defineAbility({
  key: 'medusa_gorgon_grasp', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const hit = new Set<number>();
    const n = val(a, 'volley_count');
    let r = val(a, 'radius');
    let cx = t.x, cy = t.y;
    for (let i = 0; i < n; i++) {
      const vr = r, vx = cx, vy = cy;
      u.w.emit({ n: 'gorgon_warn', x: vx, y: vy, r: vr, d: val(a, 'delay'), t: u.team });
      u.w.after(val(a, 'delay') + i * val(a, 'volley_interval'), () => {
        u.w.emit({ n: 'gorgon_grasp', x: vx, y: vy, r: vr, t: u.team });
        for (const e of u.w.enemiesIn(u.team, vx, vy, vr)) {
          if (hit.has(e.id)) continue;
          hit.add(e.id);
          damage(u, e, dmg(a, 'damage'), 'physical', a);
          const d = dur(a, 'duration');
          root(u, e, d, a, 'gorgon_grasp');
          const per = dmg(a, 'damage') * val(a, 'damage_pers') / 100;
          const iv = val(a, 'damage_interval');
          debuff(u, e, a, {
            name: 'gorgon_grasp_dot', duration: d, states: ST.revealed, interval: iv,
            onInterval(m) { damage(u, m.owner as Unit, per * iv, 'physical', a, { noProc: true }); },
          });
        }
      });
      const nr = r + val(a, 'radius_grow');
      cx += dx * (r + nr) * val(a, 'volley_spread_pct') / 200;
      cy += dy * (r + nr) * val(a, 'volley_spread_pct') / 200;
      r = nr;
    }
  },
});

// Shard: al recibir un hechizo enemigo con objetivo, devuelve una serpiente que petrifica.
defineAbility({
  key: 'medusa_cold_blooded', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'cold_blooded',
    onTargeted(_m, caster, spell) {
      const u = a.owner as Unit;
      const snake = u.abilities.find((x) => x.key === 'medusa_mystic_snake');
      if (a.cd > 0 || !snake || snake.level <= 0 || isItem(spell) || caster.team === u.team || !caster.alive) return false;
      a.cd = cooldownOf(a);
      launchSnake(u, snake, caster as Unit, { jumps: 1, stone: val(a, 'stone_form_scepter_base_tooltip'), stoneInc: 0 });
      return false;
    },
  }),
});

defineAbility({
  key: 'medusa_mana_shield', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'mana_shield', fx: 'mana_shield',
    onIncomingDamage(m, ev) {
      const u = m.owner as Unit;
      if (ev.hpRemoval || ev.amount <= 0 || u.mana <= 0) return;
      let perMana = val(a, 'damage_per_mana');
      if (u.kind === 'illusion') perMana *= 1 - val(a, 'illusion_percentage') / 100;
      const want = ev.amount * val(a, 'absorption_pct') / 100;
      const absorbed = Math.min(want, u.mana * perMana);
      u.mana -= absorbed / perMana;
      ev.amount -= absorbed;
    },
  }),
});

defineAbility({
  key: 'medusa_stone_gaze', target: 'none', ult: true, ai: { role: 'disable', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const face = new Map<number, number>();
    const cone = val(a, 'vision_cone');
    u.addMod({
      name: 'stone_gaze', duration: dur(a, 'duration'), fx: 'stone_gaze',
      props: { msPct: val(a, 'speed_boost') / 100 },
      onTick(_m, dt) {
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'), { heroes: true })) {
          if (e.findMod('stone_gaze_stone')) continue;
          // Mira a Medusa si el coseno entre su orientación y la dirección hacia ella supera vision_cone (85°).
          const ang = Math.atan2(u.y - e.y, u.x - e.x);
          const dot = Math.cos(ang - e.facing);
          if (dot < cone) continue;
          const sm = slow(u, e, a, 'stone_gaze_slow', 0.2, val(a, 'slow') / 100, val(a, 'slow'));
          if (!sm) continue;
          const acc = (face.get(e.id) ?? 0) + dt;
          face.set(e.id, acc);
          if (acc >= val(a, 'face_duration')) {
            face.set(e.id, -999);
            const bonus = val(a, 'bonus_physical_damage') / 100;
            debuff(u, e, a, {
              name: 'stone_gaze_stone', duration: val(a, 'stone_duration'), states: ST.stunned, fx: 'stone',
              onIncomingDamage(_mm, ev) { if (ev.type === 'physical' && !ev.hpRemoval) ev.amount *= 1 + bonus; },
            });
            e.atk.phase = 0;
            if (e.cast) e.w.interruptCast(e, true);
          }
        }
      },
    }, u, a);
  },
});

defineHero('medusa', ['medusa_split_shot', 'medusa_mystic_snake', 'medusa_gorgon_grasp', 'medusa_cold_blooded', 'medusa_mana_shield', 'medusa_stone_gaze'], {
  build: ['wraith_band', 'power_treads', 'dragon_lance', 'manta', 'skadi', 'butterfly', 'greater_crit'],
});
