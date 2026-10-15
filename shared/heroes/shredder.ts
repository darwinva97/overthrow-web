import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, giveMana, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, addStacks, idle, segDist } from './lib/a7';
import { castDir, dash, debuff } from './util';

const CHAKRAM = 'shredder_chakram';
const EXPOSURE = 'shredder_exposure_therapy';

/** Tala árboles y aplica Exposure Therapy (maná y, con talento, vida por árbol). */
function cut(u: Unit, x: number, y: number, r: number) {
  const n = u.w.cutTrees(x, y, r);
  const ex = abil(u, EXPOSURE);
  if (n > 0 && ex && ex.level > 0 && u.alive) {
    giveMana(u, n * val(ex, 'mana_restore'));
    const hp = val(ex, 'health_restore');
    if (hp > 0) heal(u, n * hp, u, true);
  }
  return n;
}

defineAbility({
  key: 'shredder_whirling_death', target: 'none', ai: { role: 'aoe', selfRadius: 300 },
  aoe: (a) => val(a, 'whirling_radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'whirling_radius');
    const trees = cut(u, u.x, u.y, r);
    const amount = dmg(a, 'whirling_damage') + trees * val(a, 'tree_damage_scale');
    u.w.emit({ n: 'whirling_death', x: u.x, y: u.y, r, u: u.id, t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      damage(u, e, amount, 'pure', a);
      if (!e.alive || e.kind !== 'hero' || !e.hero) continue;
      // Pierde un % de su atributo principal (o de todos si es universal).
      const attr = e.hero.attr;
      const props: Record<string, number> = {};
      if (attr === 'all') {
        const k = val(a, 'stat_loss_univ') / 100;
        props.str = -Math.floor(e.s.str * k); props.agi = -Math.floor(e.s.agi * k); props.int = -Math.floor(e.s.int * k);
      } else {
        props[attr] = -Math.floor(e.s[attr] * val(a, 'stat_loss_pct') / 100);
      }
      debuff(u, e, a, { name: 'whirling_death', duration: dur(a, 'duration'), fx: 'whirling_death', props, data: { multi: true } });
    }
  },
});

defineAbility({
  key: 'shredder_timber_chain', target: 'point', ai: { role: 'escape' }, castBeyond: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const range = castRangeOf(a);
    const cr = val(a, 'chain_radius');
    // Primer árbol en la trayectoria de la cadena.
    let tree: { x: number; y: number } | null = null;
    let dist = range;
    for (let s = 32; s <= range; s += 24) {
      const tr = u.w.nearestTree(u.x + dx * s, u.y + dy * s, cr);
      if (tr) { tree = tr; dist = s; break; }
    }
    const speed = val(a, 'speed');
    const travel = dist / speed;
    u.w.emit({ n: 'timber_chain', x: u.x, y: u.y, x2: u.x + dx * dist, y2: u.y + dy * dist, d: travel * 2, u: u.id });
    if (!tree) return;
    const tx = tree.x, ty = tree.y;
    u.w.after(travel, () => {
      if (!u.alive || u.has(ST.stunned) || u.has(ST.rooted)) return;
      const sx = u.x, sy = u.y;
      const hit = new Set<number>();
      const r = val(a, 'radius');
      const d = Math.hypot(tx - u.x, ty - u.y);
      const stop = Math.max(0, d - 70);
      const ex = u.x + (tx - u.x) / (d || 1) * stop, ey = u.y + (ty - u.y) / (d || 1) * stop;
      const hitAlong = () => {
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
          if (hit.has(e.id) || segDist(e.x, e.y, sx, sy, u.x, u.y) > r) continue;
          hit.add(e.id);
          damage(u, e, dmg(a, 'damage'), 'pure', a);
        }
      };
      dash(u, ex, ey, speed, a, {
        name: 'timber_chain', states: ST.flying,
        onStep: hitAlong,
        onArrive: () => { hitAlong(); cut(u, tx, ty, 20); },
      });
    });
  },
});

defineAbility({
  key: 'shredder_reactive_armor', target: 'none', ai: { role: 'buff', selfRadius: 450 },
  passive: (a) => ({
    name: 'reactive_armor_passive',
    onAttacked(_m, ev) {
      const u = ev.target as Unit;
      const src = ev.attacker as Unit;
      if (src.team === u.team) return;
      const n = src.isHeroLike ? val(a, 'stacks_per_hero_attack') : 1;
      addStacks(u, u, a, armorStackSpec(a), val(a, 'stack_duration'), n, val(a, 'stack_limit'));
    },
  }),
  // Scepter: se activa para cargas máximas y una barrera que crece y luego explota.
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (!hasScepter(u)) { idle(a, 3); return; }
    const limit = val(a, 'stack_limit');
    const have = u.findMod('reactive_armor', u)?.stacks ?? 0;
    addStacks(u, u, a, armorStackSpec(a), val(a, 'stack_duration'), limit - have, limit);
    const radius = val(a, 'radius');
    u.addMod({
      name: 'reactive_armor_shield', duration: val(a, 'duration'), fx: 'barrier', interval: 1,
      data: { left: val(a, 'initial_shield') },
      // La barrera no termina al agotarse: sigue creciendo hasta la explosión.
      onIncomingDamage(m, ev) {
        if (ev.hpRemoval) return;
        const take = Math.min(m.data.left, ev.amount);
        m.data.left -= take; ev.amount -= take;
      },
      onInterval(m) {
        const enemies = u.w.enemiesIn(u.team, u.x, u.y, radius, { heroes: true }).filter((e) => e.kind === 'hero').length;
        m.data.left = Math.min(val(a, 'max_shield'), m.data.left + val(a, 'shield_per_sec') + enemies * val(a, 'shield_per_sec_per_enemy'));
      },
      onDestroy(m) {
        if (!u.alive) return;
        const amount = val(a, 'base_explosion') + Math.max(0, m.data.left);
        const r = val(a, 'explosion_radius');
        u.w.emit({ n: 'aoe', x: u.x, y: u.y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true })) damage(u, e, amount, 'magical', a);
      },
    }, u, a);
  },
});

function armorStackSpec(a: AbilityInst) {
  return {
    name: 'reactive_armor', fx: 'reactive_armor',
    props: (m: any) => ({ armor: m.stacks * val(a, 'bonus_armor'), hpRegen: m.stacks * val(a, 'bonus_hp_regen') }),
  };
}

defineAbility({
  key: 'shredder_flamethrower', target: 'none', ai: { role: 'aoe', selfRadius: 350 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'flamethrower', duration: val(a, 'duration'), fx: 'flamethrower', interval: 0.1,
      onInterval() {
        const dx = Math.cos(u.facing), dy = Math.sin(u.facing);
        const len = val(a, 'length'), w = val(a, 'width');
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, len + 100)) {
          const rx = e.x - u.x, ry = e.y - u.y;
          const along = rx * dx + ry * dy;
          if (along < 0 || along > len + e.radius || Math.abs(rx * -dy + ry * dx) > w / 2 + e.radius) continue;
          debuff(u, e, a, {
            name: 'flamethrower_burn', duration: val(a, 'debuff_linger_duration'), fx: 'burn', interval: 0.5,
            props: { msSlow: val(a, 'move_slow_pct') / 100 },
            onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'damage_per_second') * 0.5, 'magical', a, { noProc: true }); },
          });
        }
      },
    }, u, a);
  },
});

interface Chakram { x: number; y: number; phase: 'out' | 'spin' | 'back'; since: number; proj?: any }

/** Hace volver el chakram a Timbersaw dañando lo que atraviesa. */
function recall(u: Unit, a: AbilityInst) {
  const c = a.data.chakram as Chakram | undefined;
  if (!c || c.phase === 'back') return;
  if (c.proj) c.proj.dead = true;
  c.phase = 'back';
  u.removeModsByName('chakram_active');
  const hit = new Set<number>();
  u.w.addProjectile({
    kind: 'track', fx: 'chakram', source: u, target: u, x: c.x, y: c.y, speed: val(a, 'speed'),
    onThink(p) {
      cut(u, p.x, p.y, 80);
      for (const e of u.w.enemiesIn(u.team, p.x, p.y, val(a, 'radius'))) {
        if (hit.has(e.id)) continue;
        hit.add(e.id);
        passHit(u, a, e);
      }
    },
    onHit() { a.data.chakram = undefined; return true; },
  });
  // Si Timbersaw muere el proyectil se pierde: el estado se limpia igualmente.
  u.w.after(4, () => { if (a.data.chakram === c) a.data.chakram = undefined; });
}

function passHit(u: Unit, a: AbilityInst, e: Unit) {
  damage(u, e, dmg(a, 'pass_damage'), 'pure', a);
  chakramSlow(u, a, e, val(a, 'pass_slow_duration'));
}

function chakramSlow(u: Unit, a: AbilityInst, e: Unit, d: number) {
  const missing = (1 - e.hp / e.s.maxHp) * 100;
  const s = Math.floor(missing / val(a, 'slow_health_percentage')) * val(a, 'slow');
  debuff(u, e, a, { name: 'chakram_slow', duration: d, fx: 'slow', props: { msSlow: Math.min(100, s) / 100 } });
}

defineAbility({
  key: 'shredder_chakram', target: 'point', ult: true, ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  castPoint: (a) => (hasScepter(a.owner as Unit) ? val(a, 'castpoint_scepter') : val(a, 'abilitycastpoint')),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const old = a.data.chakram as Chakram | undefined;
    if (old) recall(u, a);
    const [dx, dy] = castDir(u, t.x, t.y);
    const d = Math.min(castRangeOf(a), Math.hypot(t.x - u.x, t.y - u.y));
    const c: Chakram = { x: u.x, y: u.y, phase: 'out', since: u.w.time };
    a.data.chakram = c;
    const hit = new Set<number>();
    u.addMod({ name: 'chakram_active', duration: Infinity, states: ST.disarmed, fx: 'chakram' }, u, a);
    c.proj = u.w.addProjectile({
      kind: 'linear', fx: 'chakram', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'speed'), left: d, width: val(a, 'radius') * 2,
      onThink(p) { c.x = p.x; c.y = p.y; cut(u, p.x, p.y, 80); },
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || hit.has(-v.id)) return;
        hit.add(-v.id);
        passHit(u, a, v);
      },
      onEnd(p) {
        if (c.phase !== 'out') return;
        c.phase = 'spin'; c.x = p.x; c.y = p.y; c.since = u.w.time;
        c.proj = undefined;
        cut(u, c.x, c.y, val(a, 'radius'));
        const iv = val(a, 'damage_interval');
        u.w.addZone({
          fx: 'chakram', x: c.x, y: c.y, r: val(a, 'radius'), team: u.team, interval: iv, duration: 600,
          onInterval(z) {
            const back = () => { z.until = 0; recall(u, a); };
            if (a.data.chakram !== c || c.phase !== 'spin') { z.until = 0; return; }
            if (!u.alive || Math.hypot(u.x - c.x, u.y - c.y) > val(a, 'break_distance')) { back(); return; }
            const cost = val(a, 'mana_per_second') * iv;
            if (u.mana < cost) { back(); return; }
            u.mana -= cost;
            for (const e of u.w.enemiesIn(u.team, c.x, c.y, z.r)) {
              damage(u, e, dmg(a, 'damage_per_second') * iv, 'pure', a, { noProc: true });
              chakramSlow(u, a, e, iv + 0.1);
            }
            // Los bots lo recogen tras unos segundos.
            if (u.isBot && u.w.time - c.since > 3.5) back();
          },
        });
      },
    });
  },
});

defineAbility({
  key: 'shredder_return_chakram', target: 'none', levelWith: 4,
  hidden: (a) => !abil(a.owner as Unit, CHAKRAM)?.data.chakram,
  onSpellStart(a) {
    const u = a.owner as Unit;
    const ch = abil(u, CHAKRAM);
    if (!ch?.data.chakram) { idle(a, 0.5); return; }
    recall(u, ch);
  },
});

defineAbility({ key: 'shredder_exposure_therapy', target: 'passive', innate: true });

defineHero('shredder', [
  'shredder_whirling_death', 'shredder_timber_chain', 'shredder_reactive_armor', 'shredder_flamethrower',
  'shredder_chakram', 'shredder_return_chakram', 'shredder_exposure_therapy',
], {
  build: ['bracer', 'arcane_boots', 'kaya', 'blade_mail', 'ultimate_scepter', 'shivas_guard', 'kaya_and_sange', 'black_king_bar'],
});
