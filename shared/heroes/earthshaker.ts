import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, isItem, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, dash, stun } from './util';
import { distToSegment, foes, placeWall } from './lib/a3';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key && x.level > 0);

/** Aftershock alrededor de Earthshaker (y, con Shard, a lo largo de las fisuras activas). */
function aftershock(u: Unit) {
  const a = ab(u, 'earthshaker_aftershock');
  if (!a) return;
  const r = val(a, 'aftershock_range');
  u.w.emit({ n: 'aftershock', x: u.x, y: u.y, r, u: u.id, t: u.team });
  const hit = new Set<number>();
  for (const e of foes(u, u.x, u.y, r, a)) {
    hit.add(e.id);
    damage(u, e, dmg(a, 'aftershock_damage'), 'magical', a);
    stun(u, e, dur(a, 'abilityduration'), a);
  }
  // Shard: las fisuras activas también sueltan una réplica con la mitad de aturdimiento.
  const f = ab(u, 'earthshaker_fissure');
  if (!f || !hasShard(u)) return;
  const pct = val(f, 'shard_aftershock_stun_duration_pct') / 100;
  for (const s of (f.data.lines ?? []) as { x0: number; y0: number; x1: number; y1: number; until: number }[]) {
    if (s.until < u.w.time) continue;
    for (const e of foes(u, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 2 + 250, a)) {
      if (hit.has(e.id) || distToSegment(e.x, e.y, s.x0, s.y0, s.x1, s.y1) > val(f, 'fissure_radius')) continue;
      hit.add(e.id);
      damage(u, e, dmg(a, 'aftershock_damage'), 'magical', a);
      stun(u, e, dur(a, 'abilityduration') * pct, a);
    }
  }
}

defineAbility({
  key: 'earthshaker_fissure', target: 'point', ai: { role: 'disable' }, castBeyond: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = castRangeOf(a);
    const x0 = u.x + dx * 80, y0 = u.y + dy * 80;
    const x1 = u.x + dx * len, y1 = u.y + dy * len;
    const r = val(a, 'fissure_radius');
    const d = dur(a, 'fissure_duration');
    u.w.emit({ n: 'fissure', x: x0, y: y0, x2: x1, y2: y1, r, d, t: u.team });
    for (const e of foes(u, (x0 + x1) / 2, (y0 + y1) / 2, len / 2 + r, a)) {
      if (distToSegment(e.x, e.y, x0, y0, x1, y1) > r + e.radius) continue;
      damage(u, e, dmg(a, 'fissure_damage'), 'magical', a);
      stun(u, e, dur(a, 'stun_duration'), a);
    }
    placeWall(u.w, x0, y0, x1, y1, d);
    const lines = ((a.data.lines ?? []) as { until: number }[]).filter((s) => s.until > u.w.time);
    lines.push({ x0, y0, x1, y1, until: u.w.time + d } as any);
    a.data.lines = lines;
  },
});

/** Activa el tótem: el siguiente golpe hace daño extra (y barre con Scepter). */
function enchant(u: Unit, a: AbilityInst) {
  u.addMod({
    name: 'enchant_totem', duration: dur(a, 'abilityduration'), fx: 'enchant_totem', purgable: true,
    props: { damagePct: val(a, 'totem_damage_percentage') / 100 },
    onAttackLanded(m, ev) {
      if (ev.fake) return;
      a.data.slug = ev.target.id;
      const t = ev.target as Unit;
      // Barrido en cono del Scepter.
      if (hasScepter(u)) {
        const pct = val(a, 'scepter_cleave_pct') / 100;
        const dist = val(a, 'scepter_cleave_distance');
        const w0 = val(a, 'scepter_cleave_starting_width'), w1 = val(a, 'scepter_cleave_ending_width');
        const ang = Math.atan2(t.y - u.y, t.x - u.x);
        const cx = Math.cos(ang), cy = Math.sin(ang);
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, dist)) {
          if (e === t || e.kind === 'ward') continue;
          const along = (e.x - u.x) * cx + (e.y - u.y) * cy;
          const side = Math.abs(-(e.x - u.x) * cy + (e.y - u.y) * cx);
          if (along < 0 || along > dist || side > (w0 + (w1 - w0) * along / dist) / 2) continue;
          damage(u, e, ev.damage * pct, 'physical', a, { noProc: true });
        }
      }
      u.removeMod(m);
    },
  }, u, a);
}

// Sin Scepter se lanza en el sitio; con Scepter salta al punto (autolanzado = en el sitio).
defineAbility({
  key: 'earthshaker_enchant_totem', target: 'point', castBeyond: true, ai: { role: 'buff' },
  castRange: (a) => (hasScepter(a.owner as Unit) ? val(a, 'distance_scepter') : 0),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    if (!hasScepter(u) || d < 60) { enchant(u, a); return; }
    const range = val(a, 'distance_scepter');
    const go = Math.min(range, d);
    const tx = u.x + (t.x - u.x) / d * go, ty = u.y + (t.y - u.y) / d * go;
    const time = val(a, 'scepter_leap_duration');
    dash(u, tx, ty, go / time, a, {
      name: 'totem_leap',
      onArrive: () => {
        enchant(u, a);
        aftershock(u);
      },
    });
  },
});

defineAbility({
  key: 'earthshaker_aftershock', target: 'passive',
  passive: () => ({
    name: 'aftershock_passive',
    onAbilityExecuted(m, used) {
      if (isItem(used)) return;
      const u = m.owner as Unit;
      // El salto del Scepter suelta la réplica al aterrizar.
      if (used.key === 'earthshaker_enchant_totem' && hasScepter(u) && u.findMod('totem_leap')) return;
      aftershock(u);
    },
  }),
});

defineAbility({
  key: 'earthshaker_echo_slam', target: 'none', ult: true, ai: { role: 'aoe', selfRadius: 450 },
  aoe: (a) => val(a, 'echo_slam_damage_range'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'echo_slam_damage_range');
    const hit = foes(u, u.x, u.y, r, a);
    u.w.emit({ n: 'echo_slam', x: u.x, y: u.y, r, u: u.id, t: u.team });
    for (const e of hit) damage(u, e, dmg(a, 'echo_slam_initial_damage'), 'magical', a);
    // Cada unidad golpeada lanza un eco a cada enemigo cercano (los héroes, dos).
    const er = val(a, 'echo_slam_echo_search_range');
    for (const src of hit) {
      if (src.kind === 'ward') continue;
      const echoes = src.kind === 'hero' ? 2 : 1;
      const sx = src.x, sy = src.y;
      for (const e of foes(u, sx, sy, er, a)) {
        if (e === src) continue;
        const d = Math.hypot(e.x - sx, e.y - sy);
        u.w.after(0.1 + d / 1100, () => {
          if (!e.alive) return;
          u.w.emit({ n: 'echo', x: sx, y: sy, x2: e.x, y2: e.y, u2: e.id, t: u.team });
          for (let i = 0; i < echoes; i++) damage(u, e, dmg(a, 'echo_slam_echo_damage'), 'magical', a);
        });
      }
    }
  },
});

// Innata: los enemigos que mata Earthshaker con sus habilidades salen volando.
defineAbility({
  key: 'earthshaker_slugger', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'slugger',
    onDealDamage(_m, ev) {
      const u = ev.source as Unit, v = ev.target as Unit;
      if (v.hp > 0 || v.team === u.team || !v.alive) return;
      const totem = ab(u, 'earthshaker_enchant_totem');
      const byAbility = ev.ability && !isItem(ev.ability) && (ev.ability as AbilityInst).owner === u;
      const byTotem = ev.isAttack && totem && totem.data.slug === v.id;
      if (!byAbility && !byTotem) return;
      if (totem) totem.data.slug = 0;
      const hero = v.isHeroLike;
      const amount = (hero ? val(a, 'projectile_body_damage_hero') : val(a, 'projectile_body_damage_creep')) +
        v.s.maxHp * val(a, 'projectile_body_damage_additional_percent_health') / 100;
      let dx = v.x - u.x, dy = v.y - u.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      const sx = v.x, sy = v.y;
      const w = u.w;
      w.after(0, () => {
        for (const e of foes(u, sx, sy, val(a, 'projectile_body_initial_impact_radius'), a)) {
          if (e !== v) damage(u, e, amount, 'magical', a);
        }
        w.addProjectile({
          kind: 'linear', fx: 'slugger', source: u, x: sx, y: sy, dx, dy,
          speed: val(a, 'projectile_body_speed'), left: val(a, 'projectile_body_distance'),
          width: hero ? val(a, 'projectile_body_width_hero') : val(a, 'projectile_body_width_creep'),
          onHit(_p, e) {
            const t = e as Unit;
            if (t.team !== u.team && t !== v && t.kind !== 'ward') damage(u, t, amount, 'magical', a);
          },
        });
        w.addVision(u.team, sx, sy, val(a, 'projectile_body_vision'), 1);
      });
    },
  }),
});

defineHero('earthshaker', ['earthshaker_fissure', 'earthshaker_enchant_totem', 'earthshaker_aftershock', 'earthshaker_echo_slam', 'earthshaker_slugger'], {
  build: ['magic_wand', 'arcane_boots', 'blink', 'force_staff', 'black_king_bar', 'ultimate_scepter', 'refresher'],
  upgrades: [
    { slot: 0, key: 'fissure_damage', amount: 40, max: 5, label: 'Fissure: +40 daño' },
    { slot: 0, key: 'stun_duration', amount: 0.15, max: 4, label: 'Fissure: +0,15 s de aturdimiento' },
    { slot: 1, key: 'totem_damage_percentage', amount: 40, max: 5, label: 'Enchant Totem: +40% daño' },
    { slot: 2, key: 'aftershock_damage', amount: 20, max: 5, label: 'Aftershock: +20 daño' },
    { slot: 2, key: 'aftershock_range', amount: 30, max: 4, label: 'Aftershock: +30 de radio' },
    { slot: 3, key: 'echo_slam_echo_damage', amount: 15, max: 5, label: 'Echo Slam: +15 daño por eco' },
    { slot: 3, key: '_cd', amount: -10, max: 4, label: 'Echo Slam: −10 s de enfriamiento' },
  ],
});
