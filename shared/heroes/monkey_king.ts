import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import { TREE } from '../sim/nav';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, dash, slow, stun } from './util';
import { enemiesInLine, gate } from './lib/a5';

const perched = (u: Unit) => !!u.findMod('tree_perch');
const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Daño y ralentizado de Primal Spring con una fracción de su potencia. */
function springImpact(u: Unit, a: AbilityInst, x: number, y: number, power: number, only?: Unit[]) {
  const r = val(a, 'impact_radius');
  if (!only) u.w.emit({ n: 'primal_spring', x, y, r, t: u.team });
  for (const e of only ?? u.w.enemiesIn(u.team, x, y, r)) {
    damage(u, e, dmg(a, 'impact_damage') * power, 'magical', a);
    slow(u, e, a, 'primal_spring_slow', val(a, 'impact_slow_duration'), val(a, 'impact_movement_slow') * power / 100);
  }
}

defineAbility({
  key: 'monkey_king_boundless_strike', target: 'point', ai: { role: 'disable' },
  castRange: (a) => val(a, 'strike_cast_range'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = val(a, 'strike_cast_range') + u.s.castRange;
    const ex = u.x + dx * len, ey = u.y + dy * len;
    u.w.emit({ n: 'boundless_strike', x: u.x, y: u.y, x2: ex, y2: ey, r: val(a, 'strike_radius'), t: u.team });
    const hit = enemiesInLine(u, u.x, u.y, ex, ey, val(a, 'strike_radius') * 2);
    for (const e of hit) {
      stun(u, e, dur(a, 'stun_duration'), a);
      const ev = makeAttack(u, e, true);
      ev.trueStrike = true;
      ev.damage += dmg(a, 'strike_flat_damage');
      ev.critMult = Math.max(ev.critMult, val(a, 'strike_crit_mult') / 100);
      landAttack(ev);
    }
    // Shard: aplica Primal Spring con parte de su potencia.
    const ps = ability(u, 'monkey_king_primal_spring');
    if (hasShard(u) && ps && ps.level > 0) springImpact(u, ps, ex, ey, val(a, 'spring_channel_pct') / 100, hit.filter((e) => e.alive));
  },
});

defineAbility({
  key: 'monkey_king_tree_dance', target: 'point', ai: { role: 'disable' },
  castRange: (a) => val(a, perched(a.owner as Unit) ? 'perched_jump_distance' : 'ground_jump_distance'),
  // Recibir daño en el suelo pone Tree Dance en enfriamiento.
  passive: (a) => ({
    name: 'tree_dance_damage_cd',
    onTakeDamage(_m, ev) {
      const u = a.owner as Unit;
      const src = ev.source as Unit | null;
      if (!perched(u) && src && src.team !== u.team && (src.isHeroLike || src.kind === 'summon') && ev.amount > 0) {
        a.cd = Math.max(a.cd, val(a, 'jump_damage_cooldown'));
      }
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const range = castRangeOf(a) + 200;
    // Árbol más cercano al punto pulsado (el motor no tiene árboles como objetivo).
    let tree = u.w.nearestTree(t.x, t.y, 300);
    if (tree && Math.hypot(tree.x - u.x, tree.y - u.y) > range) tree = null;
    if (!tree) {
      const ang = Math.atan2(t.y - u.y, t.x - u.x);
      tree = u.w.nearestTree(u.x + Math.cos(ang) * 300, u.y + Math.sin(ang) * 300, 400);
    }
    if (!tree) { a.cd = 1; return; }
    const tr = tree;
    u.removeModsByName('tree_perch');
    dash(u, tr.x, tr.y, val(a, 'leap_speed'), a, {
      name: 'tree_dance_jump', states: ST.flying,
      onArrive() {
        if (!u.alive || u.w.grid.cellAt(tr.cx, tr.cy) !== TREE) return;
        u.x = tr.x; u.y = tr.y; u.path = [];
        u.addMod({
          name: 'tree_perch', fx: 'tree_perch', states: ST.rooted | ST.disarmed | ST.flying | ST.noCollision,
          props: { vision: 200 },
          onTick(m) {
            // Si talan el árbol, cae y queda aturdido.
            if (u.w.grid.cellAt(tr.cx, tr.cy) !== TREE) {
              u.removeMod(m);
              u.w.teleport(u, u.x, u.y);
              u.addMod({ name: 'stunned', duration: val(a, 'unperched_stunned_duration'), states: ST.stunned, fx: 'stun' }, u, a);
              return;
            }
            if (Math.hypot(u.x - tr.x, u.y - tr.y) > 40) u.removeMod(m);
          },
          // Moverse o atacar le hace bajar del árbol.
          onOrder(m, o) {
            if (o.type === 'move' || o.type === 'attack' || o.type === 'attackMove') {
              u.removeMod(m);
              u.w.teleport(u, u.x, u.y);
            }
          },
        }, u, a);
      },
    });
  },
});

defineAbility({
  key: 'monkey_king_primal_spring', target: 'point', levelWith: 1, ai: { role: 'nuke' },
  hidden: (a) => !perched(a.owner as Unit),
  aoe: (a) => val(a, 'impact_radius'),
  channel: (a) => val(a, 'abilitychanneltime'),
  passive: gate((a) => perched(a.owner as Unit)),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    a.data.start = u.w.time;
    a.data.tx = t.x; a.data.ty = t.y;
    u.w.emit({ n: 'primal_spring_warn', x: t.x, y: t.y, r: val(a, 'impact_radius'), d: val(a, 'abilitychanneltime'), t: u.team });
  },
  // Los bots sueltan el salto un poco antes de completar la canalización.
  onChannelTick(a) {
    const u = a.owner as Unit;
    if (!u.isBot || u.w.time - a.data.start < val(a, 'abilitychanneltime') * 0.8) return;
    const early = ability(u, 'monkey_king_primal_spring_early');
    if (early && !u.w.castCheck(u, early)) u.w.issueOrder(u, { type: 'cast', slot: early.slot });
  },
  onChannelEnd(a, interrupted) {
    const u = a.owner as Unit;
    // Interrumpido (aturdido, derribado) no salta; terminado o soltado antes sí.
    if ((interrupted && !a.data.early) || !u.alive) { a.data.early = false; return; }
    a.data.early = false;
    const power = Math.min(1, (u.w.time - a.data.start) / val(a, 'abilitychanneltime'));
    const tx = a.data.tx, ty = a.data.ty;
    u.removeModsByName('tree_perch');
    dash(u, tx, ty, ability(u, 'monkey_king_tree_dance') ? val(ability(u, 'monkey_king_tree_dance')!, 'spring_leap_speed') : 1300, a, {
      name: 'primal_spring_leap', states: ST.flying,
      onArrive() { springImpact(u, a, tx, ty, power); },
    });
  },
});

defineAbility({
  key: 'monkey_king_primal_spring_early', target: 'none', levelWith: 1,
  hidden: (a) => (a.owner as Unit).cast?.a.key !== 'monkey_king_primal_spring',
  onSpellStart(a) {
    const u = a.owner as Unit;
    const ps = ability(u, 'monkey_king_primal_spring');
    if (!ps || u.cast?.a !== ps) return;
    ps.data.early = true;
    u.w.interruptCast(u, false);
  },
});

defineAbility({
  key: 'monkey_king_jingu_mastery', target: 'passive',
  passive: (a) => ({
    name: 'jingu_mastery',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit;
      if (u.findMod('jingu_charged')) ev.damage += dmg(a, 'bonus_damage');
    },
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      const ch = u.findMod('jingu_charged');
      if (ch) {
        ch.stacks--;
        if (ch.stacks <= 0) ch.remaining = 0.001;
        return;
      }
      if (ev.fake || t.kind !== 'hero' || t.team === u.team) return;
      const c = t.findMod('jingu_counter', u);
      const n = (c?.stacks ?? 0) + 1;
      if (n >= val(a, 'required_hits')) {
        if (c) t.removeMod(c);
        const undisp = val(a, 'buff_is_undispellable') > 0;
        const m = u.addMod({
          name: 'jingu_charged', duration: val(a, 'max_duration'), fx: 'jingu', purgable: !undisp,
          stacks: val(a, 'charges'), props: { lifesteal: val(a, 'lifesteal') / 100 },
        }, u, a);
        m.stacks = val(a, 'charges');
        return;
      }
      const m = t.addMod({ name: 'jingu_counter', duration: val(a, 'counter_duration'), debuff: true, purgable: false, stacks: n }, u, a);
      m.stacks = n; m.remaining = m.duration = val(a, 'counter_duration');
    },
  }),
});

// Innata: disfraz. Atacar, lanzar o recibir daño lo rompe; enemigos muy cerca lo ven.
defineAbility({
  key: 'monkey_king_mischief', target: 'none', innate: true, ai: { role: 'summon', selfRadius: 1200 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({ name: 'mischief_invuln', duration: val(a, 'invul_duration'), states: ST.invulnerable }, u, a);
    u.w.emit({ n: 'mischief', x: u.x, y: u.y, u: u.id });
    u.addMod({
      name: 'mischief', fx: 'mischief', states: ST.invisible,
      data: { breaksOnAttack: true, at: u.w.time },
      onTakeDamage(m, ev) { if (ev.amount > 0) m.data.breakNow = true; },
      onTick(m) {
        const close = u.w.enemiesIn(u.team, u.x, u.y, val(a, 'reveal_radius'), { heroes: true }).some((e) => e.kind === 'hero');
        const st = close ? ST.invisible | ST.revealed : ST.invisible;
        if (m.states !== st) { m.states = st; u.refreshStats(); }
        // Los bots se quitan el disfraz al recuperarse.
        if (u.isBot && (u.hp > u.s.maxHp * 0.8 || u.w.time - m.data.at > 4)) {
          const un = ability(u, 'monkey_king_untransform');
          if (un && !u.w.castCheck(u, un)) u.w.issueOrder(u, { type: 'cast', slot: un.slot });
        }
      },
    }, u, a);
  },
});

/** Posiciones de los soldados del Wukong's Command activo. */
function soldierSpots(u: Unit): { x: number; y: number }[] {
  return u.findMod('wukongs_command')?.data.spots ?? [];
}

/** Un soldado ataca al héroe enemigo más cercano a su alcance. */
function soldierAttack(u: Unit, sx: number, sy: number) {
  const range = u.s.attackRange + 100;
  const t = u.w.enemiesIn(u.team, sx, sy, range, { heroes: true })
    .filter((e) => u.w.canSee(u.team, e))
    .sort((p, q) => Math.hypot(p.x - sx, p.y - sy) - Math.hypot(q.x - sx, q.y - sy))[0];
  if (!t || !u.alive) return;
  u.w.emit({ n: 'wukong_soldier', x: sx, y: sy, x2: t.x, y2: t.y, u: t.id, t: u.team });
  const ev = makeAttack(u, t, true);
  u.w.after(0.15, () => { if (t.alive) landAttack(ev); });
}

defineAbility({
  key: 'monkey_king_wukongs_command', target: 'point', ult: true, ai: { role: 'aoe' },
  castRange: (a) => hasScepter(a.owner as Unit) ? val(a, 'cast_range_scepter') : val(a, 'cast_range'),
  aoe: (a) => val(a, 'second_radius'),
  // Scepter: aparece un soldado junto a Monkey King cada pocos segundos.
  passive: (a) => ({
    name: 'wukong_scepter', interval: 1,
    onInterval(m) {
      const u = a.owner as Unit;
      if (!hasScepter(u) || u.kind !== 'hero') return;
      m.data.acc = (m.data.acc ?? 0) + 1;
      if (m.data.acc < val(a, 'scepter_spawn_interval')) return;
      m.data.acc = 0;
      if (u.has(ST.invisible) || perched(u)) return;
      const ang = u.w.rng() * Math.PI * 2;
      const sx = u.x + Math.cos(ang) * 150, sy = u.y + Math.sin(ang) * 150;
      u.w.addZone({
        fx: 'wukong_soldier', x: sx, y: sy, r: 40, team: u.team, interval: val(a, 'attack_speed'),
        duration: val(a, 'scepter_spawn_duration'), onInterval(z) { soldierAttack(u, z.x, z.y); },
      });
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    if (hasScepter(u)) a.cd = val(a, 'cooldown_scepter') * a.upg.cd * (1 - u.s.cdr);
    const rings: [number, number][] = [[val(a, 'first_radius'), val(a, 'num_first_soldiers')], [val(a, 'second_radius'), val(a, 'num_second_soldiers')]];
    if (val(a, 'num_third_soldiers') > 0) rings.push([val(a, 'third_radius'), val(a, 'num_third_soldiers')]);
    const spots: { x: number; y: number }[] = [{ x: t.x, y: t.y }];
    for (const [r, n] of rings) for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      spots.push({ x: t.x + Math.cos(ang) * r, y: t.y + Math.sin(ang) * r });
    }
    const outer = Math.max(...rings.map((r) => r[0]));
    const d = dur(a, 'duration');
    const zone = u.w.addZone({
      fx: 'wukongs_command', x: t.x, y: t.y, r: outer, team: u.team, interval: val(a, 'attack_speed'), duration: d,
      onInterval() { for (const s of spots) soldierAttack(u, s.x, s.y); },
    });
    u.addMod({
      name: 'wukongs_command', duration: d, fx: 'wukongs_command', data: { spots },
      props: { armor: val(a, 'bonus_armor') },
      // Si sale del área, los soldados se dispersan.
      onTick(m) {
        if (Math.hypot(u.x - t.x, u.y - t.y) > outer + 100) u.removeMod(m);
      },
      onDestroy() { zone.until = 0; },
    }, u, a);
  },
});

defineAbility({
  key: 'monkey_king_untransform', target: 'none', levelWith: 4,
  hidden: (a) => !(a.owner as Unit).findMod('mischief'),
  passive: gate((a) => !!(a.owner as Unit).findMod('mischief')),
  onSpellStart(a) { (a.owner as Unit).removeModsByName('mischief'); },
});

// Durante Wukong's Command se cambia por uno de sus soldados.
defineAbility({
  key: 'monkey_king_transfiguration', target: 'point', levelWith: 5, castBeyond: true, ai: { role: 'escape' },
  castRange: () => 1500,
  hidden: (a) => !(a.owner as Unit).findMod('wukongs_command'),
  passive: gate((a) => !!(a.owner as Unit).findMod('wukongs_command')),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const spots = soldierSpots(u);
    if (!spots.length) return;
    const s = spots.reduce((b, p) => Math.hypot(p.x - t.x, p.y - t.y) < Math.hypot(b.x - t.x, b.y - t.y) ? p : b);
    const [ox, oy] = [u.x, u.y];
    u.w.disjoint(u);
    u.w.teleport(u, s.x, s.y);
    s.x = ox; s.y = oy;
    u.w.emit({ n: 'blink', x: ox, y: oy, x2: u.x, y2: u.y, u: u.id, c: 'mk' });
    u.addMod({
      name: 'transfiguration', duration: val(a, 'transfiguration_duration'), fx: 'transfiguration',
      states: ST.invulnerable | ST.disarmed | ST.silenced | ST.muted,
    }, u, a);
  },
});

defineHero('monkey_king', ['monkey_king_boundless_strike', 'monkey_king_tree_dance', 'monkey_king_primal_spring', 'monkey_king_jingu_mastery', 'monkey_king_mischief', 'monkey_king_wukongs_command', 'monkey_king_primal_spring_early', 'monkey_king_untransform', 'monkey_king_transfiguration'], {
  build: ['wraith_band', 'phase_boots', 'echo_sabre', 'desolator', 'black_king_bar', 'basher', 'abyssal_blade'],
});
