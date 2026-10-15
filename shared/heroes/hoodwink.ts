import { castRangeOf, defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import { CELL, TREE } from '../sim/nav';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import type { World } from '../sim/world';
import { castDir, debuff, nearestEnemy, push, slow } from './util';
import { botCast, nearestEnemyHero, plantTree } from './lib/a3';

/** Vida del árbol que planta Acorn Shot (no viene en los datos). */
const ACORN_TREE_LIFE = 20;

const abil = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/** Centros de los árboles dentro de un círculo. */
function treesInArea(w: World, x: number, y: number, r: number): { x: number; y: number }[] {
  const g = w.grid;
  const out: { x: number; y: number }[] = [];
  const c0x = g.cx(x - r), c1x = g.cx(x + r), c0y = g.cy(y - r), c1y = g.cy(y + r);
  for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
    if (g.cellAt(cx, cy) !== TREE) continue;
    const px = g.centerX(cx), py = g.centerY(cy);
    if (Math.hypot(px - x, py - y) <= r + CELL / 2) out.push({ x: px, y: py });
  }
  return out;
}

const cdTime = (a: AbilityInst) => val(a, '_cd') * (1 - (a.owner as Unit).s.cdr);

// ---------------- Acorn Shot ----------------

function acornHit(a: AbilityInst, u: Unit, e: Unit) {
  const ev = makeAttack(u, e, true);
  ev.damage = ev.damage * val(a, 'base_damage_pct') / 100 + dmg(a, 'acorn_shot_damage');
  landAttack(ev);
  if (e.alive) slow(u, e, a, 'acorn_shot_slow', val(a, 'debuff_duration'), val(a, 'slow') / 100);
}

/** Bellota que rebota desde (x,y) hacia el siguiente enemigo. */
function acornBounce(a: AbilityInst, u: Unit, x: number, y: number, hit: Set<number>, left: number) {
  if (left <= 0) return;
  const next = nearestEnemy(u, x, y, val(a, 'bounce_range'), hit, true);
  if (!next) return;
  hit.add(next.id);
  u.w.addProjectile({
    kind: 'track', fx: 'attack:hoodwink', source: u, target: next, x, y, speed: val(a, 'projectile_speed'), dodgeable: true,
    onHit() {
      acornHit(a, u, next);
      u.w.after(val(a, 'bounce_delay'), () => acornBounce(a, u, next.x, next.y, hit, left - 1));
      return true;
    },
  });
}

defineAbility({
  key: 'hoodwink_acorn_shot', target: 'unitOrPoint', reflectable: false, ai: { role: 'nuke' },
  // Con el talento, 2 cargas; sin él, una carga que hace de enfriamiento normal.
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), cdTime(a)],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const hit = new Set<number>();
    const bounces = val(a, 'bounce_count');
    const e = t.unit as Unit | undefined;
    if (e && e.team !== u.team) {
      hit.add(e.id);
      u.w.addProjectile({
        kind: 'track', fx: 'attack:hoodwink', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), dodgeable: true,
        onHit() {
          acornHit(a, u, e);
          u.w.after(val(a, 'bounce_delay'), () => acornBounce(a, u, e.x, e.y, hit, bounces));
          return true;
        },
      });
      return;
    }
    // Sobre un punto: planta un árbol allí y rebota desde él.
    const [dx, dy] = castDir(u, t.x, t.y);
    const dist = Math.max(1, Math.hypot(t.x - u.x, t.y - u.y));
    u.w.addProjectile({
      kind: 'linear', fx: 'attack:hoodwink', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'projectile_speed'), left: dist, width: 1,
      onHit() { return false; },
      onEnd(p) {
        plantTree(u.w, p.x, p.y, ACORN_TREE_LIFE);
        u.w.after(val(a, 'bounce_delay'), () => acornBounce(a, u, p.x, p.y, hit, bounces));
      },
    });
  },
});

// ---------------- Bushwhack ----------------

/** Lanza una red a (x,y): aturde y arrastra al árbol más cercano a los enemigos si hay árboles en el área. */
function bushwhack(u: Unit, a: AbilityInst, x: number, y: number, r: number, stunDur: number, total: number) {
  const w = u.w;
  w.emit({ n: 'lsa', x, y, r, t: u.team });
  const trees = treesInArea(w, x, y, r);
  if (!trees.length) return;
  for (const e of w.enemiesIn(u.team, x, y, r)) {
    if (e.kind === 'ward') continue;
    let tree = trees[0], bd = Infinity;
    for (const tr of trees) { const d = Math.hypot(tr.x - e.x, tr.y - e.y); if (d < bd) { bd = d; tree = tr; } }
    const tick = 0.25;
    const m = debuff(u, e, a, {
      name: 'bushwhack', duration: stunDur, states: ST.stunned, fx: 'root', interval: tick,
      props: { vision: -5000 },
      onInterval(mm) { if (total > 0) damage(u, mm.owner as Unit, total * tick / stunDur, 'magical', a, { noProc: true }); },
      onTick(mm, dt) {
        const v = mm.owner as Unit;
        const d = Math.hypot(tree.x - v.x, tree.y - v.y);
        const stop = CELL / 2 + v.radius;
        if (d <= stop) return;
        const step = Math.min(d - stop, 1000 * dt);
        v.w.forceMove(v, v.x + (tree.x - v.x) / d * step, v.y + (tree.y - v.y) / d * step);
      },
    });
    if (m) { e.atk.phase = 0; if (e.cast) w.interruptCast(e, true); }
  }
}

defineAbility({
  key: 'hoodwink_bushwhack', target: 'point',
  aoe: (a) => val(a, 'trap_radius'),
  // Bots: solo si hay árboles junto a un héroe enemigo al alcance.
  passive: (a) => botCast(a, (u) => {
    const r = val(a, 'trap_radius');
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, castRangeOf(a) + 100, { heroes: true })) {
      if (e.kind !== 'hero' || !u.w.canSee(u.team, e)) continue;
      const trees = treesInArea(u.w, e.x, e.y, r * 0.8);
      if (!trees.length) continue;
      const tr = trees[0];
      return { x: (e.x * 2 + tr.x) / 3, y: (e.y * 2 + tr.y) / 3 };
    }
    return null;
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const dist = Math.max(1, Math.hypot(t.x - u.x, t.y - u.y));
    u.w.addProjectile({
      kind: 'linear', fx: 'hook', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'projectile_speed'), left: dist, width: 1,
      onHit() { return false; },
      onEnd() { bushwhack(u, a, t.x, t.y, val(a, 'trap_radius'), dur(a, 'debuff_duration'), dmg(a, 'total_damage')); },
    });
  },
});

// ---------------- Scurry ----------------

defineAbility({
  key: 'hoodwink_scurry', target: 'none', ai: { role: 'buff', selfRadius: 500 },
  charges: (a) => [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')],
  // Bots: también al huir.
  passive: (a) => botCast(a, (u) => (u.ai?.retreat && !u.findMod('scurry') && nearestEnemyHero(u, 900) ? u : null), 0.5),
  onSpellStart(a) {
    const u = a.owner as Unit;
    // El tree-walking no existe en el motor: queda en movimiento en fase y velocidad.
    u.addMod({
      name: 'scurry', duration: dur(a, 'duration'), fx: 'haste', states: ST.noCollision,
      props: { msPct: val(a, 'movement_speed_pct') / 100 },
      data: { evasionMult: val(a, 'evasion_multiplier') },
    }, u, a);
    abil(u, 'hoodwink_mistwoods_wayfarer')?.passiveMod?.onInterval?.(abil(u, 'hoodwink_mistwoods_wayfarer')!.passiveMod!);
  },
});

// ---------------- Sharpshooter ----------------

/** Dispara la flecha de Sharpshooter desde `src`. `mult` reduce el daño (señuelo). */
function fireArrow(a: AbilityInst, src: Unit, dx: number, dy: number, power: number, mult: number) {
  const u = a.owner as Unit;
  const w = src.w;
  const pierce = val(a, 'pierce_debuff_immunity') > 0;
  const full = dmg(a, 'max_damage') * power * mult;
  const slowDur = val(a, 'max_slow_debuff_duration') * power;
  const vis = val(a, 'arrow_vision');
  let acc = 0;
  w.emit({ n: 'laguna', x: src.x, y: src.y, x2: src.x + dx * 400, y2: src.y + dy * 400, u: src.id });
  w.addProjectile({
    kind: 'linear', fx: 'lance', source: src, x: src.x, y: src.y, dx, dy,
    speed: val(a, 'arrow_speed'), left: val(a, 'arrow_range'), width: val(a, 'arrow_width'),
    onThink(p, dt) { acc += dt; if (acc >= 0.15) { acc = 0; w.addVision(u.team, p.x, p.y, vis, 1, false); } },
    onHit(_p, e) {
      const v = e as Unit;
      if (v.team === u.team || v.kind === 'ward') return false;
      if (v.has(ST.magicImmune) && !pierce) return false;
      // Los creeps reciben la mitad y la flecha sigue; el primer héroe la detiene.
      const hero = v.isHeroLike;
      const k = hero ? 1 : 0.5;
      damage(u, v, full * k, pierce ? 'pure' : 'magical', a);
      if (v.alive) {
        const spec: ModSpec = {
          name: 'sharpshooter_debuff', duration: slowDur * k, fx: 'slow', debuff: true, states: ST.broken,
          props: { msSlow: val(a, 'slow_move_pct') / 100 },
        };
        if (pierce) v.addMod(spec, u, a);
        else debuff(u, v, a, spec);
      }
      return hero && val(a, 'pierce_units') <= 0;
    },
  });
}

defineAbility({
  key: 'hoodwink_sharpshooter', target: 'point', ult: true, ai: { role: 'nuke', hpBelow: 0.85 },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.order = null; u.path = [];
    const turn = val(a, 'turn_rate') * Math.PI / 180;
    // Carga: no se mueve ni ataca; gira despacio hacia donde se le ordene.
    u.addMod({
      name: 'sharpshooter_charge', duration: val(a, 'misfire_time'), fx: 'take_aim', states: ST.rooted | ST.disarmed,
      data: { start: u.w.time, ang: Math.atan2(dy, dx), ax: t.x, ay: t.y, aimUnit: 0, vAcc: 0 },
      onOrder(m, o) {
        if (o.type === 'move' || o.type === 'attackMove') { m.data.ax = o.x; m.data.ay = o.y; m.data.aimUnit = 0; }
        else if (o.type === 'attack' || o.type === 'follow') m.data.aimUnit = o.target;
      },
      onTick(m, dt) {
        if (u.has(ST.stunned) || u.has(ST.hexed) || u.has(ST.silenced)) { m.data.cancel = true; m.remaining = 0.001; return; }
        const tu = m.data.aimUnit ? u.w.units.get(m.data.aimUnit) : null;
        if (tu && tu.alive) { m.data.ax = tu.x; m.data.ay = tu.y; }
        const want = Math.atan2(m.data.ay - u.y, m.data.ax - u.x);
        let diff = want - m.data.ang;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        m.data.ang += Math.sign(diff) * Math.min(Math.abs(diff), turn * dt);
        u.facing = m.data.ang;
        // Talento: visión a lo largo de la línea de tiro mientras carga.
        if (val(a, 'vision_along_indicator') > 0) {
          m.data.vAcc += dt;
          if (m.data.vAcc >= 0.5) {
            m.data.vAcc = 0;
            const r = val(a, 'arrow_vision') + val(a, 'vision_radius_buffer');
            for (let d = 0; d <= val(a, 'arrow_range'); d += r * 1.5) {
              u.w.addVision(u.team, u.x + Math.cos(m.data.ang) * d, u.y + Math.sin(m.data.ang) * d, r, 0.6, false);
            }
          }
        }
      },
      onDestroy(m) {
        if (m.data.cancel || !u.alive) return;
        const max = val(a, 'max_charge_time');
        const base = val(a, 'base_power');
        const power = base + (1 - base) * Math.min(1, (u.w.time - m.data.start) / max);
        const ex = Math.cos(m.data.ang), ey = Math.sin(m.data.ang);
        fireArrow(a, u, ex, ey, power, 1);
        push(u, -ex, -ey, val(a, 'recoil_distance'), val(a, 'recoil_duration'), u, a, 'sharpshooter_recoil');
      },
    }, u, a);
  },
});

defineAbility({
  key: 'hoodwink_sharpshooter_release', target: 'none', levelWith: 5, sub: true,
  hidden: (a) => !(a.owner as Unit).findMod('sharpshooter_charge'),
  // Bots: sueltan al llegar a la carga máxima.
  passive: (a) => botCast(a, (u) => {
    const m = u.findMod('sharpshooter_charge');
    const sh = abil(u, 'hoodwink_sharpshooter');
    if (!m || !sh) return null;
    return u.w.time - m.data.start >= val(sh, 'max_charge_time') ? { x: u.x, y: u.y } : null;
  }, 0.2),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const m = u.findMod('sharpshooter_charge');
    if (m) u.removeMod(m);
  },
});

// ---------------- Decoy (Scepter) ----------------

defineAbility({
  key: 'hoodwink_decoy', target: 'none', ai: { role: 'buff', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const d = dur(a, 'duration');
    u.addMod({
      name: 'decoy_invis', duration: d, fx: 'invis', states: ST.invisible, data: { breaksOnAttack: true },
      props: { msPct: val(a, 'movement_speed') / 100 },
    }, u, a);
    const il = w.spawnIllusion(u, u.x, u.y, d, val(a, 'images_do_damage_percent') / 100 - 1, val(a, 'images_take_damage_percent') / 100 - 1);
    const sh = abil(u, 'hoodwink_sharpshooter');
    let done = false;
    // Al ser atacado o señalado, revienta y lanza una red menor hacia el enemigo.
    const detonate = (enemy: Unit) => {
      if (done || !il.alive) return;
      done = true;
      const x = il.x, y = il.y;
      il.hp = 0; il.alive = false;
      w.emit({ n: 'death', x, y, u: il.id });
      w.removeLater(il, 0.3);
      w.addProjectile({
        kind: 'track', fx: 'hook', source: u, target: enemy, x, y, speed: val(a, 'projectile_speed'),
        onHit() {
          const r = val(a, 'decoy_detonate_radius');
          w.emit({ n: 'lsa', x: enemy.x, y: enemy.y, r, t: u.team });
          for (const e of w.enemiesIn(u.team, enemy.x, enemy.y, r)) {
            const m = debuff(u, e, a, { name: 'bushwhack', duration: val(a, 'decoy_stun_duration'), states: ST.stunned, fx: 'root', props: { vision: -5000 } });
            if (m && e.cast) w.interruptCast(e, true);
          }
          return true;
        },
      });
    };
    il.addMod({
      name: 'decoy_illusion', persistent: true, data: { start: w.time, fired: false },
      onAttacked(_m, ev) { if (ev.attacker.team !== u.team) detonate(ev.attacker as Unit); },
      onTargeted(_m, caster) { if (caster.team !== u.team) detonate(caster as Unit); return false; },
      onTick(m) {
        if (m.data.fired || !sh || sh.level <= 0) return;
        const tgt = nearestEnemyHero(il, val(sh, 'arrow_range'));
        if (tgt) il.facing = Math.atan2(tgt.y - il.y, tgt.x - il.x);
        if (w.time - m.data.start < val(sh, 'max_charge_time')) return;
        m.data.fired = true;
        if (!tgt) return;
        const [dx, dy] = castDir(il, tgt.x, tgt.y);
        fireArrow(sh, il, dx, dy, 1, val(a, 'sharpshooter_damage_pct') / 100);
      },
    }, u, a);
    il.addMod({ name: 'decoy_root', persistent: true, states: ST.rooted | ST.disarmed }, u, a);
  },
});

// ---------------- Hunter's Boomerang (Shard) ----------------

defineAbility({
  key: 'hoodwink_hunters_boomerang', target: 'unitOrPoint', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const [dx, dy] = castDir(u, t.x, t.y);
    const dist = Math.min(castRangeOf(a), Math.max(150, Math.hypot(t.x - u.x, t.y - u.y)));
    const hit = new Set<number>();
    const r = val(a, 'radius');
    const onHit = (_p: unknown, e: Unit) => {
      const v = e as Unit;
      if (v.team === u.team || v.kind === 'ward' || hit.has(v.id)) return false;
      hit.add(v.id);
      damage(u, v, dmg(a, 'damage'), 'magical', a);
      const amp = val(a, 'spell_amp') / 100;
      debuff(u, v, a, {
        name: 'hunters_mark', duration: dur(a, 'mark_duration'), fx: 'slow',
        props: { msSlow: val(a, 'slow_pct') / 100, statusResist: -val(a, 'status_resistance') / 100 },
        onIncomingDamage(_m, ev) { if (!ev.isAttack && ev.ability && !ev.hpRemoval) ev.amount *= 1 + amp; },
      });
      return false;
    };
    // Ida en línea recta (sin la curva) y vuelta persiguiendo a Hoodwink.
    w.addProjectile({
      kind: 'linear', fx: 'boomerang', source: u, x: u.x, y: u.y, dx, dy, speed: val(a, 'speed'), left: dist, width: r * 2,
      onHit,
      onEnd(p) {
        w.addProjectile({
          kind: 'linear', fx: 'boomerang', source: u, x: p.x, y: p.y, dx: -dx, dy: -dy, speed: val(a, 'speed'), left: 99999, width: r * 2,
          onHit,
          onThink(q) {
            const d = Math.hypot(u.x - q.x, u.y - q.y);
            if (d < 60 || !u.alive) { q.dead = true; return; }
            q.dx = (u.x - q.x) / d; q.dy = (u.y - q.y) / d;
          },
        });
      },
    });
  },
});

// ---------------- Mistwoods Wayfarer (innata) ----------------

// Aproximación: cerca de árboles, probabilidad de desviar ataques (evasión), doble con Scurry.
defineAbility({
  key: 'hoodwink_mistwoods_wayfarer', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'mistwoods_wayfarer', interval: 0.25, data: { near: false, mult: 1 },
    props: (m) => (m.data.near ? { evasion: Math.min(1, val(a, 'redirect_chance') / 100 * m.data.mult) } : {}),
    onInterval(m) {
      const u = m.owner as Unit;
      const near = !!u.w.nearestTree(u.x, u.y, val(a, 'radius'));
      const mult = u.findMod('scurry')?.data.evasionMult ?? 1;
      if (near !== m.data.near || mult !== m.data.mult) { m.data.near = near; m.data.mult = mult; u.refreshStats(); }
    },
  }),
});

defineHero('hoodwink', [
  'hoodwink_acorn_shot', 'hoodwink_bushwhack', 'hoodwink_scurry', 'hoodwink_decoy', 'hoodwink_hunters_boomerang',
  'hoodwink_sharpshooter', 'hoodwink_sharpshooter_release', 'hoodwink_mistwoods_wayfarer',
], {
  build: ['wraith_band', 'power_treads', 'maelstrom', 'dragon_lance', 'black_king_bar', 'hurricane_pike', 'ultimate_scepter', 'greater_crit'],
});
