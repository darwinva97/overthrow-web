import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botAllyTarget, dist, pct } from './lib/a9';
import { canDebuff, castDir, debuff, slow } from './util';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Ataque adicional de Geminate (proyectil propio con daño extra); no vuelve a activar Geminate. */
let geminating = false;
function geminate(a: AbilityInst, u: Unit, t: Unit) {
  if (!u.alive || !t.alive || !u.w.targetable(t)) return;
  geminating = true;
  const ev = makeAttack(u, t);
  geminating = false;
  ev.damage += dmg(a, 'bonus_damage');
  u.w.addProjectile({
    kind: 'track', fx: 'attack:weaver', source: u, target: t, x: u.x, y: u.y, speed: u.base.projSpeed, dodgeable: true,
    onHit: () => { landAttack(ev); return true; },
  });
}

defineAbility({
  key: 'weaver_the_swarm', target: 'point', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const [dx, dy] = castDir(u, t.x, t.y);
    const n = val(a, 'count'), sr = val(a, 'spawn_radius');
    for (let i = 0; i < n; i++) {
      const off = n > 1 ? -sr + (2 * sr * i) / (n - 1) : 0;
      w.addProjectile({
        kind: 'linear', fx: 'weaver_swarm', source: u, x: u.x - dy * off, y: u.y + dx * off, dx, dy,
        speed: val(a, 'speed'), left: val(a, 'abilitycastrange') + u.s.castRange, width: val(a, 'radius') * 2,
        onHit(_p, e) {
          const v = e as Unit;
          if (v.team === u.team || v.kind === 'ward' || v.name === 'weaver_swarm' || !canDebuff(u, v, a)) return false;
          // Un escarabajo por unidad.
          if (v.mods.some((m) => m.name === 'swarm_armor')) return false;
          latch(a, v);
          return true;
        },
      });
    }
  },
});

/** Escarabajo pegado a `v`: ataca cada cierto tiempo y quita armadura; muere a golpes. */
function latch(a: AbilityInst, v: Unit) {
  const u = a.owner as Unit;
  const w = u.w;
  const b = w.spawnSummon(u, 'weaver_swarm', v.x, v.y, dur(a, 'duration'), { abilities: [], hp: val(a, 'destroy_attacks') });
  const ang = w.rng() * Math.PI * 2;
  const deb = debuff(u, v, a, {
    name: 'swarm_armor', duration: dur(a, 'duration'), stacks: 0, fx: 'swarm', purgable: false,
    props: (m) => ({ armor: -val(a, 'armor_reduction') * m.stacks }),
  });
  if (deb) deb.caster = b;
  b.addMod({
    name: 'swarm_latch', persistent: true, interval: val(a, 'attack_rate'), states: ST.rooted | ST.noCollision | ST.disarmed,
    // Solo los ataques le hacen daño: uno por golpe.
    onIncomingDamage(_m, ev) { ev.amount = ev.isAttack ? 1 : 0; },
    onTick() {
      if (!v.alive) { b.expireAt = w.time; return; }
      b.x = v.x + Math.cos(ang) * 30; b.y = v.y + Math.sin(ang) * 30;
    },
    onInterval() {
      if (!v.alive || !b.alive) return;
      damage(u, v, dmg(a, 'damage'), 'physical', a);
      if (deb && v.mods.includes(deb)) { deb.stacks++; v.refreshStats(); }
    },
    onDestroy() { if (deb) v.removeMod(deb); },
  }, u, a);
}

defineAbility({
  key: 'weaver_shukuchi', target: 'none', ai: { role: 'nuke', selfRadius: 500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const hit = new Set<number>();
    const marks = new Set<number>();
    w.emit({ n: 'fade', x: u.x, y: u.y, u: u.id });
    const m = u.addMod({
      name: 'shukuchi', duration: dur(a, 'duration'), fx: 'shukuchi', states: ST.noCollision,
      props: { msFlat: val(a, 'speed'), msFixed: val(a, 'min_movespeed_override') },
      data: { breaksOnAttack: true },
      onTick(mm) {
        if (!mm.data.faded && mm.duration - mm.remaining >= val(a, 'fade_time')) {
          mm.data.faded = true; mm.states = ST.noCollision | ST.invisible; u.refreshStats();
        }
        for (const e of w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) {
          if (hit.has(e.id)) continue;
          hit.add(e.id);
          damage(u, e, dmg(a, 'damage'), 'magical', a);
          if (val(a, 'geminate_attack_mark_duration') > 0) marks.add(e.id);
        }
      },
      onDestroy() {
        // Shard: los marcados reciben un Geminate al salir de Shukuchi.
        const g = ab(u, 'weaver_geminate_attack');
        if (!marks.size || !g || g.level <= 0) return;
        w.after(val(a, 'shukuchi_attack_delay'), () => {
          for (const id of marks) {
            const e = w.units.get(id);
            if (e && e.alive && dist(e, u) <= val(a, 'shukuchi_attack_mark_radius')) geminate(g, u, e);
          }
        });
      },
    }, u, a);
    m.data.faded = false;
  },
});

defineAbility({
  key: 'weaver_geminate_attack', target: 'passive',
  passive: (a) => ({
    name: 'geminate_attack',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (geminating || ev.fake || a.cd > 0 || t.team === u.team) return;
      a.cd = cooldownOf(a);
      const n = val(a, 'extra_attack');
      for (let i = 1; i <= n; i++) u.w.after(val(a, 'delay') * i, () => geminate(a, u, t));
    },
  }),
});

defineAbility({
  key: 'weaver_time_lapse', target: 'unitOrPoint', team: 'ally', allowSelf: true, ult: true, noIllusion: true, ai: { role: 'heal' },
  // Historial de posición, vida y maná de los últimos segundos (propio y, con Scepter, de los aliados).
  passive: (a) => ({
    name: 'time_lapse_history', interval: 0.1, data: { hist: {} as Record<number, { t: number; x: number; y: number; hp: number; mana: number }[]> },
    onOrder: botAllyTarget(a, (u) => (pct(u) < 0.4 ? u : null)).onOrder,
    onInterval(m) {
      const u = m.owner as Unit;
      const w = u.w;
      const list = hasScepter(u) ? w.list.filter((x) => x.kind === 'hero' && x.team === u.team) : [u];
      for (const x of list) {
        if (!x.alive) continue;
        const h = (m.data.hist[x.id] ??= []);
        h.push({ t: w.time, x: x.x, y: x.y, hp: x.hp, mana: x.mana });
        while (h.length && h[0].t < w.time - 5.2) h.shift();
      }
    },
    onRespawn(m) { m.data.hist = {}; },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    let e = u;
    if (t.unit && t.unit !== u && hasScepter(u) && (t.unit as Unit).team === u.team &&
      dist(t.unit, u) <= val(a, 'abilitycastrange') + u.s.castRange + 50) e = t.unit as Unit;
    const h = a.passiveMod?.data.hist?.[e.id] as { t: number; x: number; y: number; hp: number; mana: number }[] | undefined;
    const snap = h?.find((s) => s.t >= u.w.time - 5) ?? h?.[0];
    e.purge(true, false, true);
    u.w.disjoint(e);
    if (e.cast?.phase === 2) u.w.interruptCast(e, true);
    if (!snap) return;
    const fx = e.x, fy = e.y;
    u.w.teleport(e, snap.x, snap.y);
    e.hp = Math.max(e.hp, Math.min(e.s.maxHp, snap.hp));
    e.mana = Math.min(e.s.maxMana, snap.mana);
    u.w.emit({ n: 'time_lapse', x: fx, y: fy, x2: e.x, y2: e.y, u: e.id });
  },
});

defineAbility({
  key: 'weaver_threads_of_fate', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'threads_of_fate', data: { pending: new Map<number, number>(), threads: new Map<number, number>() },
    props: (m) => ({ damage: (m.data.threads as Map<number, number>).size * val(a, 'damage_per_thread_hero') }),
    onDealDamage(m, ev) {
      const t = ev.target as Unit;
      if (t.kind !== 'hero' || t.team === (m.owner as Unit).team) return;
      if (!m.data.threads.has(t.id) && !m.data.pending.has(t.id)) m.data.pending.set(t.id, (m.owner as Unit).w.time);
    },
    onTick(m) {
      const u = m.owner as Unit;
      const w = u.w;
      const pending = m.data.pending as Map<number, number>, threads = m.data.threads as Map<number, number>;
      for (const [id, since] of pending) {
        const e = w.units.get(id);
        if (!e || !e.alive || dist(e, u) > val(a, 'thread_setup_distance')) { pending.delete(id); continue; }
        if (w.time - since < val(a, 'thread_setup_time')) continue;
        pending.delete(id);
        threads.set(id, w.time + val(a, 'established_thread_duration'));
        slow(u, e, a, 'threads_of_fate_slow', val(a, 'slow_duration'), val(a, 'slow_percent') / 100);
        w.emit({ n: 'thread_of_fate', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
        u.refreshStats();
      }
      let changed = false;
      for (const [id, until] of threads) {
        const e = w.units.get(id);
        if (e && !e.alive && !m.data['dead' + id]) {
          // Al morir el enemigo, el hilo dura un poco más.
          m.data['dead' + id] = true;
          threads.set(id, Math.min(until, w.time + val(a, 'death_linger_duration')));
          continue;
        }
        const broken = e && e.alive && dist(e, u) > val(a, 'established_thread_break_distance');
        if (!e || until <= w.time || broken) { threads.delete(id); delete m.data['dead' + id]; changed = true; }
      }
      if (changed) u.refreshStats();
    },
  }),
});

defineHero('weaver', ['weaver_the_swarm', 'weaver_shukuchi', 'weaver_geminate_attack', 'weaver_time_lapse', 'weaver_threads_of_fate'], {
  build: ['wraith_band', 'power_treads', 'maelstrom', 'dragon_lance', 'black_king_bar', 'greater_crit', 'butterfly'],
});
