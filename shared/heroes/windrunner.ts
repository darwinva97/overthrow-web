import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import type { Unit } from '../sim/unit';
import { dist } from './lib/a9';
import { canDebuff, castDir, slow, stun } from './util';

defineAbility({
  key: 'windrunner_shackleshot', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const ox = u.x, oy = u.y;
    u.w.addProjectile({
      kind: 'track', fx: 'shackleshot', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'arrow_speed'), dodgeable: true,
      onHit() {
        if (!canDebuff(u, e, a)) return true;
        const w = u.w;
        const l = Math.hypot(e.x - ox, e.y - oy) || 1;
        const dx = (e.x - ox) / l, dy = (e.y - oy) / l;
        const reach = val(a, 'shackle_distance');
        const cone = val(a, 'shackle_angle') * Math.PI / 180;
        const inCone = (x: number, y: number) => {
          const vx = x - e.x, vy = y - e.y;
          const d = Math.hypot(vx, vy);
          if (d < 1 || d > reach) return false;
          return Math.acos(Math.max(-1, Math.min(1, (vx * dx + vy * dy) / d))) <= cone;
        };
        const d = dur(a, 'stun_duration');
        // Unidad enemiga detrás del objetivo.
        const other = w.enemiesIn(u.team, e.x, e.y, reach, { immune: false })
          .filter((x) => x !== e && x.kind !== 'ward' && inCone(x.x, x.y))
          .sort((p, q) => dist(p, e) - dist(q, e))
          .slice(0, val(a, 'shackle_count'));
        if (other.length) {
          stun(u, e, d, a);
          for (const o of other) {
            if (canDebuff(u, o, a)) stun(u, o, d, a);
            w.emit({ n: 'shackle', x: e.x, y: e.y, x2: o.x, y2: o.y, u: e.id, u2: o.id, d });
          }
          return true;
        }
        // O un árbol.
        for (let s = 40; s <= reach; s += 40) {
          const tr = w.nearestTree(e.x + dx * s, e.y + dy * s, 48);
          if (tr && inCone(tr.x, tr.y)) {
            stun(u, e, d, a);
            w.emit({ n: 'shackle', x: e.x, y: e.y, x2: tr.x, y2: tr.y, u: e.id, d });
            return true;
          }
        }
        stun(u, e, val(a, 'fail_stun_duration'), a);
        return true;
      },
    });
  },
});

defineAbility({
  key: 'windrunner_powershot', target: 'point', ai: { role: 'nuke' },
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    a.data.dir = castDir(u, t.x, t.y);
    a.data.t = 0;
    u.w.emit({ n: 'powershot_charge', x: u.x, y: u.y, u: u.id, d: val(a, 'abilitychanneltime') });
  },
  onChannelTick(a, dt) { a.data.t += dt; },
  // Se dispara al acabar o al interrumpirse, con la carga acumulada.
  onChannelEnd(a) {
    const u = a.owner as Unit;
    if (!u.alive || !a.data.dir) return;
    const [dx, dy] = a.data.dir as [number, number];
    a.data.dir = null;
    const k = Math.min(1, a.data.t / Math.max(0.01, val(a, 'abilitychanneltime')));
    let mult = 1;
    const red = val(a, 'damage_reduction') / 100;
    const exec = val(a, 'min_execute_threshold') + (val(a, 'max_execute_threshold') - val(a, 'min_execute_threshold')) * k;
    const range = val(a, 'arrow_range') + u.s.castRange;
    for (let d = 0; d <= range; d += val(a, 'vision_radius')) {
      u.w.addVision(u.team, u.x + dx * d, u.y + dy * d, val(a, 'vision_radius'), val(a, 'vision_duration'), false);
    }
    u.w.addProjectile({
      kind: 'linear', fx: 'powershot', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'arrow_speed'), left: range, width: val(a, 'arrow_width'),
      onThink(p) { u.w.cutTrees(p.x, p.y, val(a, 'tree_width')); },
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || !canDebuff(u, v, a)) return;
        if (exec > 0 && v.kind === 'hero' && v.hp / v.s.maxHp * 100 < exec) {
          damage(u, v, v.hp + 1, 'pure', a, { hpRemoval: true });
        } else {
          damage(u, v, dmg(a, 'powershot_damage') * k * mult, 'magical', a);
        }
        slow(u, v, a, 'powershot_slow', dur(a, 'slow_duration'), val(a, 'slow') / 100 * k * mult);
        mult *= 1 - red;
      },
    });
  },
});

defineAbility({
  key: 'windrunner_windrun', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'windrun', duration: dur(a, 'abilityduration'), fx: 'windrun', purgable: !val(a, 'cannot_be_dispelled'),
      props: { msPct: val(a, 'movespeed_bonus_pct') / 100, evasion: val(a, 'evasion_pct_tooltip') / 100 },
    }, u, a);
  },
});

defineAbility({
  key: 'windrunner_gale_force', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const [dx, dy] = castDir(u, t.x, t.y);
    const r = val(a, 'radius'), s = val(a, 'wind_strength');
    w.emit({ n: 'gale_force', x: t.x, y: t.y, x2: t.x + dx * r, y2: t.y + dy * r, r, d: val(a, 'duration'), t: u.team });
    w.addZone({
      fx: 'gale_force', x: t.x, y: t.y, r, team: u.team, interval: 1 / 30, duration: val(a, 'duration'),
      onInterval(z) {
        for (const e of w.enemiesIn(u.team, z.x, z.y, r)) w.forceMove(e, e.x + dx * s * z.interval, e.y + dy * s * z.interval);
      },
    });
  },
});

defineAbility({
  key: 'windrunner_focusfire_cancel', target: 'toggle', levelWith: 5,
  hidden: (a) => !(a.owner as Unit).findMod('focus_fire'),
  onToggle(a) {
    const u = a.owner as Unit;
    u.removeModsByName('focus_fire');
    a.toggled = false;
  },
});

defineAbility({
  key: 'windrunner_focusfire', target: 'unit', ult: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const id = e.id;
    const attacking = () => u.atk.target === id || (u.order?.type === 'attack' && u.order.target === id);
    u.addMod({
      name: 'focus_fire', duration: dur(a, 'abilityduration'), fx: 'focus_fire', purgable: false,
      data: { target: id, on: false },
      props: (m) => ({ attackSpeed: m.data.on ? val(a, 'bonus_attack_speed') : 0 }),
      onTick(m) {
        const on = attacking();
        if (on !== m.data.on) { m.data.on = on; u.refreshStats(); }
      },
      onAttackStart(_m, ev) { if (ev.target.id === id) ev.damage *= 1 + val(a, 'focusfire_damage_reduction') / 100; },
      onKill(_m, victim) {
        if (victim.id === id && victim.kind === 'hero') a.cd = Math.max(0, a.cd - val(a, 'cooldown_reduction_per_kill'));
      },
    }, u, a);
    // La orden de ataque se da al tick siguiente (el lanzamiento limpia la orden actual).
    u.w.after(0, () => { if (u.alive && e.alive) u.w.issueOrder(u, { type: 'attack', target: id }); });
  },
});

/** Una carga de Tailwind: velocidad que empieza a decaer a mitad de duración. */
function tailwind(a: AbilityInst, u: Unit) {
  const d = val(a, 'duration');
  u.addMod({
    name: 'tailwind', duration: d, fx: 'tailwind', purgable: !val(a, 'undispellable'), data: { multi: true },
    props: (m) => ({ msPct: val(a, 'movespeed_bonus') / 100 * Math.min(1, m.remaining / (d / 2)) }),
    onTick(m) { if (m.remaining < d / 2 && u.w.tickN % 5 === 0) u.refreshStats(); },
  }, u, a);
}

defineAbility({
  key: 'windrunner_tailwind', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'tailwind_passive',
    onAbilityExecuted(m, s) {
      if ((s as { isItem?: boolean }).isItem) return;
      tailwind(a, m.owner as Unit);
    },
    onAttackStart(m, ev) { if (val(a, 'applies_on_attack') > 0 && !ev.fake) tailwind(a, m.owner as Unit); },
  }),
});

defineHero('windrunner', ['windrunner_shackleshot', 'windrunner_powershot', 'windrunner_windrun', 'windrunner_gale_force',
  'windrunner_focusfire_cancel', 'windrunner_focusfire', 'windrunner_tailwind'], {
  build: ['null_talisman', 'phase_boots', 'maelstrom', 'black_king_bar', 'monkey_king_bar', 'ultimate_scepter', 'greater_crit'],
});
