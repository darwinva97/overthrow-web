import { cooldownOf, defineAbility, defineHero, dmg, dur, hasTalent, manaCostOf, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { fly, gate, isUnitLike, refund } from './lib/a8';
import { castDir, push, slow, stun } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

defineAbility({
  key: 'tusk_ice_shards', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const [dx, dy] = castDir(u, t.x, t.y);
    const range = val(a, 'abilitycastrange') + u.s.castRange;
    const len = Math.max(100, Math.min(range, Math.hypot(t.x - u.x, t.y - u.y)));
    const hit = new Set<number>();
    const make = (cx: number, cy: number) => {
      const n = val(a, 'shard_count');
      const step = val(a, 'shard_angle_step') * Math.PI / 180;
      const base = Math.atan2(dy, dx);
      const D = dur(a, 'shard_duration');
      const shardR = 70;
      // Arco de témpanos alrededor del punto, abierto hacia Tusk.
      const shards: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const ang = base + (i - (n - 1) / 2) * step;
        const sx = cx + Math.cos(ang) * val(a, 'shard_distance'), sy = cy + Math.sin(ang) * val(a, 'shard_distance');
        shards.push([sx, sy]);
        w.addZone({ fx: 'ice_shard', x: sx, y: sy, r: shardR, team: u.team, interval: 99, duration: D, onInterval() {} });
      }
      const talent = hasTalent(u, 'special_bonus_unique_tusk_shard_dps');
      w.addZone({
        fx: '', x: cx, y: cy, r: 0, team: u.team, interval: 1 / 30, duration: D,
        onInterval() {
          // Los témpanos son muros: nadie que camine los atraviesa.
          for (const [sx, sy] of shards) {
            for (const v of w.unitsIn(sx, sy, shardR, (x) => isUnitLike(x) && !x.has(ST.flying))) {
              const d = Math.hypot(v.x - sx, v.y - sy) || 1;
              const need = shardR + v.radius * 0.5;
              if (d < need) w.forceMove(v, sx + (v.x - sx) / d * need, sy + (v.y - sy) / d * need);
            }
          }
        },
      });
      if (talent) {
        w.addZone({
          fx: '', x: cx, y: cy, r: 0, team: u.team, interval: 0.25, duration: D,
          onInterval() {
            const seen = new Set<number>();
            for (const [sx, sy] of shards) for (const e of w.enemiesIn(u.team, sx, sy, val(a, 'shard_width'))) {
              if (seen.has(e.id)) continue;
              seen.add(e.id);
              slow(u, e, a, 'ice_shards_chill', 0.4, val(a, 'aghs_shard_move_slow') / 100);
              damage(u, e, val(a, 'aghs_shard_damage') * 0.25, 'magical', a, { noProc: true });
            }
          },
        });
      }
    };
    w.addProjectile({
      kind: 'linear', fx: 'ice_shards', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'shard_speed'), left: len, width: val(a, 'shard_width'),
      onHit(_p, e) {
        if (e.team === u.team || e.kind === 'ward' || hit.has(e.id)) return false;
        hit.add(e.id);
        damage(u, e as Unit, dmg(a, 'shard_damage'), 'magical', a);
        return false;
      },
      onEnd(p) { make(p.x, p.y); },
    });
  },
});

/** Bola de nieve en curso (en los datos de la habilidad). */
interface Ball { target: number; riders: Unit[]; launched: boolean; born: number; launchedAt: number; hit: Set<number> }

defineAbility({
  key: 'tusk_snowball', target: 'unit', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const e = t.unit as Unit;
    // Aproximación: los héroes aliados que están al lado se suben solos.
    const riders = w.alliesIn(u.team, u.x, u.y, val(a, 'snowball_grab_radius'), { heroes: true })
      .filter((x) => x !== u && x.kind === 'hero' && !x.has(ST.busy));
    const ball: Ball = { target: e.id, riders, launched: false, born: w.time, launchedAt: 0, hit: new Set() };
    a.data.ball = ball;
    const inside = ST.hidden | ST.invulnerable | ST.untargetable | ST.busy | ST.noCollision;
    for (const r of riders) { r.order = null; r.addMod({ name: 'snowball_rider', duration: 10, states: inside }, u, a); }
    w.disjoint(u);
    u.order = null; u.path = [];
    const end = () => {
      a.data.ball = null;
      u.removeModsByName('snowball');
      for (const r of riders) { r.removeModsByName('snowball_rider'); if (r.alive) w.teleport(r, u.x + (w.rng() - 0.5) * 80, u.y + (w.rng() - 0.5) * 80); }
    };
    u.addMod({
      name: 'snowball', duration: val(a, 'snowball_windup') + val(a, 'snowball_duration') + 1, fx: 'snowball',
      states: ST.invulnerable | ST.untargetable | ST.busy | ST.noCollision,
      onTick(m, dt) {
        const n = riders.filter((r) => r.alive).length;
        for (const r of riders) if (r.alive) { r.x = u.x; r.y = u.y; }
        if (!ball.launched) {
          if (w.time - ball.born < val(a, 'snowball_windup')) return;
          ball.launched = true; ball.launchedAt = w.time;
        }
        const tgt = w.units.get(ball.target);
        const ok = tgt && tgt.alive && w.targetable(tgt) && w.canSee(u.team, tgt);
        const radius = val(a, 'snowball_radius') + val(a, 'snowball_grow_rate') * (w.time - ball.born);
        if (ok) {
          const d = Math.hypot(tgt.x - u.x, tgt.y - u.y);
          const step = (val(a, 'snowball_speed') + val(a, 'snowball_speed_bonus') * n) * dt;
          if (d > 1) { u.facing = Math.atan2(tgt.y - u.y, tgt.x - u.x); w.forceMove(u, u.x + (tgt.x - u.x) / d * Math.min(step, d), u.y + (tgt.y - u.y) / d * Math.min(step, d)); }
        }
        const amount = dmg(a, 'snowball_damage') + val(a, 'snowball_damage_bonus') * n;
        const st = dur(a, 'stun_duration') + val(a, 'stun_duration_bonus') * n;
        for (const v of w.enemiesIn(u.team, u.x, u.y, radius)) {
          if (ball.hit.has(v.id) || v.kind === 'ward') continue;
          ball.hit.add(v.id);
          damage(u, v, amount, 'magical', a);
          stun(u, v, st, a);
        }
        const arrived = ok && Math.hypot(tgt.x - u.x, tgt.y - u.y) <= radius * 0.5 + tgt.radius;
        if (arrived || !ok || w.time - ball.launchedAt >= val(a, 'snowball_duration')) { m.remaining = 0.001; }
      },
      onDestroy() { if (a.data.ball === ball) end(); },
    }, u, a);
  },
});

defineAbility({
  key: 'tusk_launch_snowball', target: 'none', levelWith: 1, ai: { role: 'aoe', selfRadius: 5000 },
  hidden: (a) => !snowball(a)?.data.ball,
  passive: (a) => ({ name: 'launch_snowball_gate', onTick() { gate(a, !!snowball(a)?.data.ball && !snowball(a)!.data.ball.launched); } }),
  onSpellStart(a) {
    const b = snowball(a)?.data.ball as Ball | undefined;
    if (b && !b.launched) { b.launched = true; b.launchedAt = (a.owner as Unit).w.time; }
  },
});
function snowball(a: AbilityInst) { return ability(a.owner as Unit, 'tusk_snowball'); }

defineAbility({
  key: 'tusk_tag_team', target: 'none', ai: { role: 'buff', selfRadius: 350 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'tag_team', duration: dur(a, 'debuff_duration'), fx: 'tag_team',
      aura: {
        radius: val(a, 'radius'), team: 'enemy',
        apply: () => ({
          name: 'tag_team_debuff', debuff: true, fx: 'tag_team',
          // Cada ataque aliado recibido hace daño extra y frena en seco.
          onAttacked(m, ev) {
            if (ev.missed || ev.attacker.team !== u.team) return;
            ev.damage += dmg(a, 'bonus_damage');
            slow(u, m.owner as Unit, a, 'tag_team_slow', val(a, 'slow_duration'), val(a, 'movement_slow') / 100);
          },
        }),
      },
    }, u, a);
  },
});

defineAbility({
  key: 'tusk_drinking_buddies', target: 'unit', team: 'any', reflectable: false, ai: { role: 'buff' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    let al = t.unit && t.unit.team === u.team && t.unit !== u ? (t.unit as Unit) : null;
    // Sobre un enemigo (bots): el héroe aliado más cercano.
    if (!al) {
      al = w.alliesIn(u.team, u.x, u.y, val(a, 'max_distance'), { heroes: true }).filter((x) => x !== u)
        .sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))[0] ?? null;
    }
    if (!al) { refund(a); return; }
    const d = Math.hypot(al.x - u.x, al.y - u.y);
    const go = d - val(a, 'min_distance');
    if (go > 0) push(al, u.x - al.x, u.y - al.y, go, val(a, 'pull_duration'), u, a, 'drinking_buddies_pull');
    for (const x of [u, al]) {
      x.addMod({ name: 'drinking_buddies', duration: val(a, 'buff_duration'), fx: 'drinking_buddies',
        props: { msPct: val(a, 'movespeed_bonus') / 100, armor: val(a, 'armor_bonus') } }, u, a);
    }
  },
});

defineAbility({
  key: 'tusk_walrus_kick', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const e = t.unit as Unit;
    // Sin vector en la interfaz: patea hacia la fuente propia (hacia el equipo de Tusk).
    const f = w.teams[u.team]?.fountain ?? { x: u.x, y: u.y };
    let dx = f.x - e.x, dy = f.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    const L = val(a, 'push_length');
    const ex = e.x + dx * L, ey = e.y + dy * L;
    damage(u, e, dmg(a, 'damage'), 'magical', a);
    if (!e.isHeroLike) a.cd *= 1 - val(a, 'creep_cooldown_reduction_pct') / 100;
    if (!e.alive) return;
    fly(e, () => [ex, ey], val(a, 'air_time'), u, a, 0, (v) => {
      slow(u, v, a, 'walrus_kick_slow', val(a, 'slow_duration'), val(a, 'move_slow') / 100);
      for (const h of w.enemiesIn(u.team, v.x, v.y, val(a, 'search_radius'), { heroes: true })) if (h !== v) damage(u, h, dmg(a, 'damage'), 'magical', a);
    }, 'walrus_kick');
  },
});

defineAbility({
  key: 'tusk_walrus_punch', target: 'toggle', ult: true, ai: { role: 'nuke' },
  passive: (a) => ({
    name: 'walrus_punch',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (ev.fake || t.team === u.team || !isUnitLike(t)) return;
      let go = false;
      if (a.toggled && a.cd <= 0 && u.mana >= manaCostOf(a) && !u.has(ST.silenced) && u.kind !== 'illusion') {
        u.mana -= manaCostOf(a);
        a.cd = cooldownOf(a);
        go = true;
      } else if (val(a, 'proc_chance') > 0 && u.w.rng() < val(a, 'proc_chance') / 100) go = true;
      if (!go) return;
      (ev as any).punch = true;
      ev.critMult = Math.max(ev.critMult, val(a, 'crit_multiplier') / 100);
      ev.damage += dmg(a, 'bonus_damage');
    },
    onAttackLanded(_m, ev) {
      if (!(ev as any).punch) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      u.w.emit({ n: 'walrus_punch', x: t.x, y: t.y, u: t.id });
      // Lo manda por los aires: aturdido mientras vuela.
      if (stun(u, t, dur(a, 'air_time'), a)) t.w.disjoint(t);
    },
  }),
});

defineAbility({
  key: 'tusk_bitter_chill', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'bitter_chill',
    aura: {
      radius: val(a, 'radius'), team: 'enemy', heroesOnly: true,
      apply: () => ({ name: 'bitter_chill_slow', debuff: true, props: { attackSlow: val(a, 'attack_speed_slow') } }),
    },
  }),
});

defineHero('tusk', ['tusk_ice_shards', 'tusk_snowball', 'tusk_tag_team', 'tusk_drinking_buddies', 'tusk_walrus_kick',
  'tusk_walrus_punch', 'tusk_launch_snowball', 'tusk_bitter_chill'], {
  build: ['phase_boots', 'magic_wand', 'blink', 'black_king_bar', 'desolator', 'assault', 'ultimate_scepter'],
});

