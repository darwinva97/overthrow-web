import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, giveMana, heal, landAttack, makeAttack } from '../sim/combat';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import type { World } from '../sim/world';
import { botBrain, currentTarget, distToSegment, inCone, nearestEnemyHero } from './lib/a4';
import { canDebuff, castDir, debuff, push, slow, stun } from './util';

/** Arenas activas (para que Spear of Mars se clave en sus muros). */
interface Arena { w: World; x: number; y: number; r: number; width: number; team: number; until: number }
let ARENAS: Arena[] = [];
const arenasOf = (w: World) => (ARENAS = ARENAS.filter((z) => z.until > z.w.time)).filter((z) => z.w === w);

/** ¿Hay obstáculo (árbol, acantilado o muro de arena) en (x,y)? */
function blocked(w: World, x: number, y: number) {
  if (!w.grid.walkable(x, y)) return true;
  return arenasOf(w).some((z) => Math.abs(Math.hypot(x - z.x, y - z.y) - z.r) < z.width / 2);
}

defineAbility({
  key: 'mars_spear', target: 'point', ai: { role: 'disable' },
  castRange: (a) => val(a, 'spear_range'),
  castBeyond: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const [dx, dy] = castDir(u, t.x, t.y);
    const sx = u.x, sy = u.y;
    const impaled: Unit[] = [];
    const max = val(a, 'max_impale_targets');
    const release = (p: { x: number; y: number }) => {
      for (const e of impaled) {
        e.removeModsByName('spear_impaled');
        if (e.alive) push(e, dx, dy, val(a, 'knockback_distance'), val(a, 'knockback_duration'), u, a, 'spear_knockback');
      }
      trail(p.x, p.y);
    };
    // Shard: rastro de fuego por donde pasa la lanza.
    const trail = (ex: number, ey: number) => {
      const td = val(a, 'shard_trail_duration');
      if (td <= 0) return;
      const tr = val(a, 'shard_trail_radius');
      w.addZone({
        fx: 'spear_trail', x: (sx + ex) / 2, y: (sy + ey) / 2, r: tr, team: u.team, interval: val(a, 'shard_interval'), duration: td,
        onInterval() {
          for (const e of w.enemiesIn(u.team, (sx + ex) / 2, (sy + ey) / 2, Math.hypot(ex - sx, ey - sy) / 2 + tr)) {
            if (distToSegment(e.x, e.y, sx, sy, ex, ey) > tr || !canDebuff(u, e, a)) continue;
            damage(u, e, val(a, 'shard_dps') * val(a, 'shard_interval'), 'magical', a, { noProc: true });
            slow(u, e, a, 'spear_trail_slow', val(a, 'shard_debuff_linger_duration'), val(a, 'shard_move_slow_pct') / 100);
          }
        },
      });
    };
    w.addProjectile({
      kind: 'linear', fx: 'mars_spear', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'spear_speed'), left: castRangeOf(a), width: val(a, 'spear_width'),
      onHit(_p, v) {
        const e = v as Unit;
        if (e.team === u.team || e.kind === 'ward' || !canDebuff(u, e, a)) return false;
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        // Los primeros héroes quedan ensartados y viajan con la lanza.
        if (e.alive && e.isHeroLike && impaled.length < max) {
          const m = debuff(u, e, a, { name: 'spear_impaled', duration: 3, states: ST.stunned, fx: 'spear_impaled', purgable: false });
          if (m) { impaled.push(e); if (e.cast) w.interruptCast(e, true); }
        }
        return false;
      },
      onThink(p) {
        if (!impaled.length) return;
        for (const e of impaled) if (e.alive) w.forceMove(e, p.x, p.y);
        const lead = impaled[0].radius + 20;
        if (!blocked(w, p.x + dx * lead, p.y + dy * lead)) return;
        // Choca contra un obstáculo: queda clavado y aturdido.
        p.dead = true;
        w.emit({ n: 'spear_impale', x: p.x, y: p.y, t: u.team });
        for (const e of impaled) {
          e.removeModsByName('spear_impaled');
          if (e.alive) stun(u, e, dur(a, 'stun_duration'), a);
        }
        trail(p.x, p.y);
      },
      onEnd(p) {
        w.addVision(u.team, p.x, p.y, val(a, 'spear_vision'), 1);
        release(p);
      },
    });
  },
});

defineAbility({
  key: 'mars_gods_rebuke', target: 'point', castBeyond: true,
  castRange: (a) => val(a, 'radius'),
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.facing = Math.atan2(dy, dx);
    const r = val(a, 'radius');
    u.w.emit({ n: 'gods_rebuke', x: u.x, y: u.y, x2: u.x + dx * r, y2: u.y + dy * r, r, u: u.id, t: u.team });
    // Golpe crítico basado en el ataque, con True Strike.
    const base = (u.s.dmgMin + u.s.dmgMax) / 2 + u.s.dmgBonus;
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      if (e.kind === 'ward' || !canDebuff(u, e, a) || !inCone(u.x, u.y, dx, dy, e.x, e.y, r + e.radius, val(a, 'angle') / 2)) continue;
      const crit = (val(a, 'crit_mult') + (e.isHeroLike ? val(a, 'bonus_damage_vs_heroes') : 0)) / 100;
      damage(u, e, base * crit * a.upg.dmg, 'physical', a, { crit: true });
      if (!e.alive) continue;
      push(e, e.x - u.x, e.y - u.y, val(a, 'knockback_distance'), val(a, 'knockback_duration'), u, a, 'gods_rebuke_knockback');
      slow(u, e, a, 'gods_rebuke_slow', val(a, 'knockback_slow_duration'), val(a, 'knockback_slow') / 100);
    }
  },
  passive: (a) => botBrain(a, (u) => {
    const t = currentTarget(u) ?? nearestEnemyHero(u, val(a, 'radius'));
    if (!t || Math.hypot(t.x - u.x, t.y - u.y) > val(a, 'radius') * 0.9) return null;
    return { x: t.x, y: t.y };
  }),
});

/** Diferencia angular absoluta entre dos direcciones (radianes). */
function angDiff(a: number, b: number) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

defineAbility({
  key: 'mars_bulwark', target: 'toggle',
  // Bloqueo pasivo de ataques físicos de frente y de lado.
  passive: (a) => {
    const brain = botBrain(a, (u) => {
      const ranged = u.w.enemiesIn(u.team, u.x, u.y, val(a, 'redirect_range'), { heroes: true }).filter((e) => !e.melee && e.kind === 'hero');
      const allies = u.w.alliesIn(u.team, u.x, u.y, val(a, 'redirect_range'), { heroes: true }).filter((x) => x !== u && x.kind === 'hero');
      const fleeing = !!u.ai?.retreat && ranged.length > 0;
      const want = fleeing || (ranged.length > 0 && allies.some((x) => x.hp / x.s.maxHp < 0.6));
      return want !== a.toggled ? { x: u.x, y: u.y } : null;
    }, 0.5);
    return {
      name: 'bulwark', onTick: brain.onTick,
      onIncomingDamage(_m, ev) {
        const u = ev.target as Unit;
        const s = ev.source as Unit | null;
        if (!ev.isAttack || ev.type !== 'physical' || !s) return;
        const diff = angDiff(u.facing, Math.atan2(s.y - u.y, s.x - u.x)) * 180 / Math.PI;
        if (diff <= val(a, 'forward_angle') / 2) ev.amount *= 1 - val(a, 'physical_damage_reduction') / 100;
        else if (diff <= val(a, 'side_angle') / 2) ev.amount *= 1 - val(a, 'physical_damage_reduction_side') / 100;
      },
    };
  },
  onToggle(a, on) {
    const u = a.owner as Unit;
    if (!on) { u.removeModsByName('bulwark_active'); return; }
    u.addMod({
      name: 'bulwark_active', fx: 'bulwark', states: ST.noCollision | ST.disarmed,
      props: { msSlow: val(a, 'redirect_speed_penatly') / 100 },
      onTick(m) {
        const o = m.owner as Unit;
        const w = o.w;
        // Redirige parte de los ataques a distancia contra aliados hacia Mars.
        for (const p of w.projectiles) {
          const t = p.target as Unit | null;
          if (p.dead || p.kind !== 'track' || !p.fx.startsWith('attack') || (p as any).bulwark || !t || t === o) continue;
          if (t.team !== o.team || p.source.team === o.team) continue;
          if (Math.hypot(t.x - o.x, t.y - o.y) > val(a, 'redirect_range')) continue;
          if (Math.hypot(t.x - p.x, t.y - p.y) < val(a, 'redirect_close_range')) continue;
          (p as any).bulwark = true;
          if (w.rng() >= val(a, 'redirect_chance') / 100) continue;
          const src = p.source as Unit;
          p.target = o;
          p.onHit = () => { if (src.alive) landAttack(makeAttack(src, o, true)); return true; };
        }
      },
      onDestroy() { a.toggled = false; },
    }, u, a);
  },
});

defineAbility({
  key: 'mars_dauntless', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'dauntless', interval: 0.25, data: { n: 0 },
    props: (m) => ({ hpRegen: val(a, 'health_regen_per_enemy') * m.data.n }),
    onInterval(m) {
      const u = m.owner as Unit;
      const r = val(a, 'radius');
      const foes = u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true }).filter((e) => e.kind === 'hero').length;
      const friends = u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true }).filter((x) => x.kind === 'hero' && x !== u).length;
      // Más regeneración cuanto más en inferioridad está.
      const n = Math.max(0, foes - friends);
      if (n !== m.data.n) { m.data.n = n; u.refreshStats(); }
    },
  }),
});

defineAbility({
  key: 'mars_arena_of_blood', target: 'point', ult: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const cx = t.x, cy = t.y;
    const r = val(a, 'radius'), width = val(a, 'width');
    const d = dur(a, 'duration');
    w.after(val(a, 'formation_time'), () => {
      const arena: Arena = { w, x: cx, y: cy, r, width, team: u.team, until: w.time + d };
      ARENAS.push(arena);
      w.emit({ n: 'arena_of_blood', x: cx, y: cy, r, d, t: u.team });
      const inside = new Map<number, boolean>();
      const lastSpear = new Map<number, number>();
      const inner = r - width / 2, outer = r + width / 2;
      w.addZone({
        fx: 'arena_of_blood', x: cx, y: cy, r, team: u.team, interval: 1 / 30, duration: d,
        onInterval() {
          for (const e of w.list) {
            if (!e.alive || e.kind === 'fountain' || e.kind === 'throne' || e.kind === 'orb' || e.kind === 'kobold') continue;
            const ex = e.x - cx, ey = e.y - cy;
            const dist = Math.hypot(ex, ey) || 1;
            if (e.team === u.team) {
              const regen = val(a, 'health_regen');
              if (regen > 0 && dist < r && e.isHeroLike) e.addMod({ name: 'arena_regen', duration: 0.2, props: { hpRegen: regen } }, u, a);
              continue;
            }
            // Los muros no dejan pasar a los enemigos (lejos del muro se recalcula el lado: blinks).
            if (!inside.has(e.id) || Math.abs(dist - r) > 150) inside.set(e.id, dist < r);
            if (inside.get(e.id)) {
              if (dist > inner - e.radius) w.forceMove(e, cx + ex / dist * (inner - e.radius - 1), cy + ey / dist * (inner - e.radius - 1));
              // Lanzas contra los héroes pegados al muro interior.
              if (e.isHeroLike && dist > r - val(a, 'spear_distance_from_wall') && w.time - (lastSpear.get(e.id) ?? -9) >= val(a, 'spear_attack_interval')) {
                lastSpear.set(e.id, w.time);
                if (canDebuff(u, e, a) || val(a, 'pierces_debuff_immunity') > 0) {
                  w.emit({ n: 'arena_spear', x: e.x, y: e.y, u: e.id, t: u.team });
                  damage(u, e, dmg(a, 'spear_damage'), 'magical', a);
                  if (e.alive) push(e, -ex, -ey, val(a, 'spear_distance_from_wall'), 0.2, u, a, 'arena_spear_knockback');
                }
              }
            } else if (dist < outer + e.radius) {
              w.forceMove(e, cx + ex / dist * (outer + e.radius + 1), cy + ey / dist * (outer + e.radius + 1));
            }
          }
          // Los guerreros bloquean los ataques a distancia enemigos que cruzan el muro.
          for (const p of w.projectiles) {
            if (p.dead || p.kind !== 'track' || !p.fx.startsWith('attack') || p.source.team === u.team || !p.target) continue;
            const pd = Math.hypot(p.x - cx, p.y - cy);
            if (Math.abs(pd - r) > width / 2 + 10) continue;
            const tIn = Math.hypot(p.target.x - cx, p.target.y - cy) < r;
            const sIn = Math.hypot(p.source.x - cx, p.source.y - cy) < r;
            if (tIn !== sIn) p.dead = true;
          }
        },
      });
      // Scepter: matar dentro de la arena cura y potencia a los aliados de dentro.
      if (hasScepter(u)) {
        u.addMod({
          name: 'arena_of_blood_watch', duration: d,
          onAnyDeath(_m, victim) {
            if (victim.team === u.team || victim.kind !== 'hero' || Math.hypot(victim.x - cx, victim.y - cy) > r) return;
            for (const al of w.alliesIn(u.team, cx, cy, r, { heroes: true })) {
              if (al.kind !== 'hero') continue;
              heal(al, al.s.maxHp * val(a, 'arena_kill_buff_heal_pct') / 100, u);
              giveMana(al, al.s.maxMana * val(a, 'arena_kill_buff_heal_pct') / 100);
              al.addMod({
                name: 'arena_kill_buff', duration: val(a, 'arena_kill_buff_duration'), data: { multi: true }, fx: 'arena_kill_buff',
                props: { damagePct: val(a, 'arena_kill_buff_damage_pct') / 100 },
              }, u, a);
            }
          },
        }, u, a);
      }
    });
  },
});

defineHero('mars', ['mars_spear', 'mars_gods_rebuke', 'mars_bulwark', 'mars_dauntless', 'mars_arena_of_blood'], {
  build: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'desolator', 'assault', 'ultimate_scepter'],
});
