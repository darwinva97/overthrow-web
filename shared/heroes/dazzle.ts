import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, heal, launchAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, hex } from './util';
import { aiBy, botCast } from './lib/a2';

const nothl = (u: Unit) => u.findMod('nothl_projection');
const ultOf = (u: Unit) => u.abilities.find((x) => x.key === 'dazzle_nothl_projection' && x.level > 0);

/** Weave: cada hechizo de Dazzle da armadura a aliados y la quita a enemigos (instancias acumulables). */
function weave(u: Unit, t: Unit) {
  const w = u.abilities.find((x) => x.key === 'dazzle_innate_weave');
  if (!w || !t.alive) return;
  const ally = t.team === u.team;
  if (ally ? !val(w, 'affects_allies') : !val(w, 'affects_enemies')) return;
  const armor = val(w, 'armor_change') * (ally ? 1 : -1);
  const spec = { name: 'weave', duration: val(w, 'duration'), fx: ally ? 'weave_ally' : 'weave_enemy', props: { armor }, data: { multi: true } };
  if (ally) t.addMod(spec, u, w);
  else if (!debuff(u, t, w, { ...spec, purgable: false })) return;
  // Shard: curación por cada instancia al aplicarla a un aliado.
  if (ally && hasShard(u)) heal(t, val(w, 'ally_heal') * t.mods.filter((m) => m.name === 'weave' && m.caster === u).length, u);
}

defineAbility({
  key: 'dazzle_poison_touch', target: 'unit', reflectable: true, ai: { role: 'disable' },
  // Talento: más alcance de ataque contra objetivos envenenados.
  passive: (a) => ({
    name: 'poison_touch_range', interval: 0.25,
    props: (m) => (m.data.on ? { attackRange: val(a, 'attack_range_bonus') } : {}),
    onInterval(m) {
      const u = m.owner as Unit;
      const t = u.w.units.get(u.atk.target);
      const on = !!t && !!t.findMod('poison_touch', u) && val(a, 'attack_range_bonus') > 0;
      if (on !== !!m.data.on) { m.data.on = on; u.refreshStats(); }
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = Math.hypot(e.x - u.x, e.y - u.y) || 1;
    const dx = (e.x - u.x) / d, dy = (e.y - u.y) / d;
    const L = val(a, 'end_distance');
    const r0 = val(a, 'start_radius'), r1 = val(a, 'end_radius');
    // Cono: el objetivo primero y luego los más cercanos dentro del cono.
    const cands = u.w.enemiesIn(u.team, u.x, u.y, L + r1).filter((v) => {
      const px = v.x - u.x, py = v.y - u.y;
      const along = px * dx + py * dy;
      if (along < -50 || along > L) return false;
      const perp = Math.abs(px * dy - py * dx);
      return perp <= r0 + (r1 - r0) * Math.max(0, along) / L + v.radius;
    }).filter((v) => v !== e).sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y));
    const targets = [e, ...cands].slice(0, val(a, 'targets'));
    const hexDur = nothl(u) ? val(ultOf(u)!, 'poison_touch_hex') : 0;
    u.w.emit({ n: 'poison_touch', x: u.x, y: u.y, x2: e.x, y2: e.y, r: r1, u: u.id });
    for (const v of targets) {
      u.w.addProjectile({
        kind: 'track', fx: 'poison_touch', source: u, target: v, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), dodgeable: true,
        onHit() {
          if (v.has(ST.magicImmune)) return true;
          debuff(u, v, a, {
            name: 'poison_touch', duration: dur(a, 'duration'), fx: 'poison', interval: 1, stacks: 0,
            props: (m) => ({ msSlow: (Math.abs(val(a, 'slow')) + m.stacks * Math.abs(val(a, 'bonus_slow'))) / 100 }),
            onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'damage') + val(a, 'bonus_damage'), 'physical', a, { noProc: true }); },
            // Cada ataque de Dazzle refresca y aumenta la ralentización.
            onAttacked(m, ev) {
              if (ev.attacker !== u || ev.missed) return;
              m.stacks++; m.remaining = m.duration;
              (m.owner as Unit).refreshStats();
            },
          });
          if (hexDur > 0) hex(u, v, hexDur, a, 140);
          weave(u, v);
          return true;
        },
      });
    }
  },
});

defineAbility({
  key: 'dazzle_shallow_grave', target: 'unit', team: 'ally', allowSelf: true, ai: aiBy('heal'),
  passive: (a) => botCast(a, (u) => {
    const r = castRangeOf(a);
    const al = u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true })
      .find((v) => v.hp / v.s.maxHp < 0.25 && u.w.enemiesIn(u.team, v.x, v.y, 900, { heroes: true }).length);
    return al ? { unit: al } : null;
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const ult = nothl(u) ? ultOf(u) : null;
    e.addMod({
      name: 'shallow_grave', duration: dur(a, 'duration'), fx: 'shallow_grave', interval: 0.25,
      // Amplifica la curación según la vida que le falte.
      props: (m) => {
        const v = m.owner as Unit;
        const missing = v.s ? 1 - v.hp / v.s.maxHp : 0;
        return { healAmp: val(a, 'heal_amplify') * missing * 10 / 100 };
      },
      onInterval(m) { (m.owner as Unit).refreshStats(); },
      onIncomingDamage(m, ev) {
        const v = m.owner as Unit;
        if (ev.amount >= v.hp) ev.amount = Math.max(0, v.hp - 1);
      },
      onDestroy(m) {
        const v = m.owner as Unit;
        if (ult && v.alive && m.remaining <= 0.0001) heal(v, val(ult, 'shallow_grave_heal'), u);
      },
    }, u, a);
    weave(u, e);
  },
});

defineAbility({
  key: 'dazzle_shadow_wave', target: 'unit', team: 'any', allowSelf: true, ai: aiBy('heal'),
  passive: (a) => botCast(a, (u) => {
    const r = castRangeOf(a);
    if (hasScepter(u)) {
      const e = u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true }).find((v) => !v.has(ST.magicImmune));
      if (e) return { unit: e };
    }
    const al = u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true }).find((v) => v.s.maxHp - v.hp > 150);
    if (al) return { unit: al };
    const near = u.w.enemiesIn(u.team, u.x, u.y, 300).length;
    return near ? { unit: u } : null;
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const first = (t.unit as Unit) ?? u;
    const sc = hasScepter(u);
    if (first.team !== u.team && !sc) { a.cd = 0; u.mana += val(a, '_mc'); return; }
    if (sc) a.cd += val(a, 'scepter_cd_increase');
    const ult = nothl(u) ? ultOf(u) : null;
    if (ult) a.cd *= 1 - val(ult, 'shadow_wave_cdr') / 100;
    const amount = dmg(a, 'damage');
    const hit = new Set<number>();
    const hurt = new Set<number>();
    const healAt = (v: Unit) => {
      heal(v, amount, u);
      weave(u, v);
      for (const e of u.w.enemiesIn(u.team, v.x, v.y, val(a, 'damage_radius'))) {
        if (hurt.has(e.id)) continue;
        hurt.add(e.id);
        damage(u, e, amount, 'physical', a);
        weave(u, e);
      }
    };
    const enemyAt = (e: Unit) => {
      if (e.has(ST.magicImmune)) return;
      damage(u, e, amount, 'physical', a);
      weave(u, e);
      if (e.alive) launchAttack(u, e, true);
      for (const al of u.w.alliesIn(u.team, e.x, e.y, val(a, 'damage_radius'))) if (al.isHeroLike) heal(al, amount * val(a, 'scepter_heal_pct') / 100, u);
    };
    let cur: Unit | null = first;
    let prev = u;
    const max = val(a, 'max_targets');
    for (let i = 0; i < max && cur; i++) {
      hit.add(cur.id);
      u.w.emit({ n: 'shadow_wave', x: prev.x, y: prev.y, x2: cur.x, y2: cur.y, u: prev.id, u2: cur.id });
      if (cur.team === u.team) healAt(cur); else enemyAt(cur);
      prev = cur;
      const from: Unit = cur;
      cur = u.w.unitsIn(from.x, from.y, val(a, 'bounce_radius'), (v) => !hit.has(v.id) && v !== u && u.w.targetable(v) &&
        ((v.team === u.team && (v.isHeroLike || v.kind === 'creep' || v.kind === 'summon')) || (sc && v.team !== u.team && !v.has(ST.invulnerable) && v.kind !== 'fountain')))
        .sort((p, q) => Number(q.team === u.team) - Number(p.team === u.team) || Math.hypot(p.x - from.x, p.y - from.y) - Math.hypot(q.x - from.x, q.y - from.y))[0] ?? null;
    }
    // Dazzle siempre se cura.
    if (!hit.has(u.id)) healAt(u);
  },
});

defineAbility({
  key: 'dazzle_innate_weave', target: 'passive', innate: true,
  passive: () => null,
});

defineAbility({
  key: 'dazzle_nothl_projection', target: 'point', ult: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const bx = u.x, by = u.y;
    const start = u.w.time;
    u.w.disjoint(u);
    u.w.emit({ n: 'nothl_body', x: bx, y: by, u: u.id, d: val(a, 'max_duration') });
    u.addMod({
      name: 'nothl_projection', duration: val(a, 'max_duration'), fx: 'nothl',
      states: ST.invulnerable | ST.noCollision, data: { bx, by, start, tx: t.x, ty: t.y },
      onTick(m, dt) {
        const v = m.owner as Unit;
        // Viaje inicial del alma hacia el punto.
        if (!m.data.arrived) {
          const d = Math.hypot(m.data.tx - v.x, m.data.ty - v.y);
          const step = val(a, 'initial_travel_speed') * dt;
          if (d <= step) { v.w.forceMove(v, m.data.tx, m.data.ty); m.data.arrived = true; }
          else v.w.forceMove(v, v.x + (m.data.tx - v.x) / d * step, v.y + (m.data.ty - v.y) / d * step);
          return;
        }
        // Correa: más allá de cierta distancia tira hacia el cuerpo, cada vez más fuerte.
        const d = Math.hypot(bx - v.x, by - v.y);
        if (d > val(a, 'leash_start')) {
          const over = d - val(a, 'leash_start');
          const pull = (val(a, 'base_leash_pull') + over * val(a, 'leash_increase')) * dt;
          v.w.forceMove(v, v.x + (bx - v.x) / d * pull, v.y + (by - v.y) / d * pull);
        }
      },
      onDestroy(m) {
        const v = m.owner as Unit;
        if (!v.alive) return;
        // Vuelve al cuerpo.
        v.w.emit({ n: 'blink', x: v.x, y: v.y, x2: m.data.bx, y2: m.data.by, u: v.id });
        v.addMod({ name: 'nothl_return', duration: val(a, 'soul_return_time'), states: ST.invulnerable | ST.busy | ST.noCollision, fx: 'nothl',
          onDestroy() { if (v.alive) v.w.teleport(v, m.data.bx, m.data.by); } }, u, a);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'dazzle_nothl_projection_end', target: 'none', levelWith: 4, ai: aiBy('escape'),
  hidden: (a) => !nothl(a.owner as Unit),
  passive: (a) => botCast(a, (u) => {
    const m = nothl(u);
    const ult = ultOf(u);
    if (!m || !ult) return null;
    const t = u.w.time - m.data.start;
    if (t < val(ult, 'min_duration')) return null;
    return !u.w.enemiesIn(u.team, u.x, u.y, 900, { heroes: true }).length || t > 8 ? {} : null;
  }),
  noIllusion: true,
  onSpellStart(a) {
    const m = nothl(a.owner as Unit);
    if (m) m.remaining = 0.001;
  },
});

defineHero('dazzle', ['dazzle_poison_touch', 'dazzle_shallow_grave', 'dazzle_shadow_wave', 'dazzle_innate_weave', 'dazzle_nothl_projection', 'dazzle_nothl_projection_end'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'guardian_greaves', 'ultimate_scepter', 'sheepstick', 'refresher'],
  upgrades: [
    { slot: 0, key: 'damage', amount: 8, max: 5, label: 'Poison Touch: +8 daño por segundo' },
    { slot: 1, key: 'duration', amount: 0.3, max: 4, label: 'Shallow Grave: +0,3 s' },
    { slot: 2, key: 'damage', amount: 25, max: 5, label: 'Shadow Wave: +25 curación y daño' },
    { slot: 2, key: 'max_targets', amount: 1, max: 3, label: 'Shadow Wave: +1 objetivo' },
    { slot: 4, key: 'max_duration', amount: 1, max: 4, label: 'Nothl Projection: +1 s' },
  ],
});
