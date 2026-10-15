import { cooldownOf, defineAbility, defineHero, dmg, hasShard, hasTalent, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { enemiesInLine, fly, gate, isUnitLike, refund } from './lib/a8';
import { slow, stun } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
const grow = (u: Unit) => { const g = ability(u, 'tiny_grow'); return g && g.level > 0 ? g : null; };

/** Shard: lo que cae de Toss y de los árboles ralentiza en área. */
function shardLanding(u: Unit, x: number, y: number, r: number) {
  const g = ability(u, 'tiny_grow');
  if (!hasShard(u) || !g) return;
  for (const e of u.w.enemiesIn(u.team, x, y, r)) {
    slow(u, e, g, 'tiny_land_slow', val(g, 'land_debuff_duration'), val(g, 'land_movement_slow') / 100, val(g, 'land_attack_slow'));
  }
}

defineAbility({
  key: 'tiny_avalanche', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const delay = Math.hypot(t.x - u.x, t.y - u.y) / val(a, 'projectile_speed');
    const r = val(a, 'radius');
    const n = val(a, 'tick_count');
    w.emit({ n: 'avalanche', x: t.x, y: t.y, r, d: delay + val(a, 'total_duration'), t: u.team });
    w.after(delay, () => {
      let i = 0;
      w.addZone({
        fx: 'avalanche', x: t.x, y: t.y, r, team: u.team, interval: val(a, 'tick_interval'), duration: val(a, 'total_duration'),
        onInterval(z) {
          if (i++ >= n) return;
          for (const e of w.enemiesIn(u.team, z.x, z.y, z.r)) {
            damage(u, e, dmg(a, 'avalanche_damage') / n, 'magical', a);
            stun(u, e, val(a, 'stun_duration'), a);
          }
        },
      });
    });
  },
});

defineAbility({
  key: 'tiny_toss', target: 'unitOrPoint', team: 'any', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  // Talento: 2 cargas, cada una con el enfriamiento normal.
  passive: (a) => ({
    name: 'toss_charges',
    onTick(_m, dt) {
      const u = a.owner as Unit;
      if (!hasTalent(u, 'special_bonus_unique_tiny_2')) return;
      a.data.stock ??= 2;
      if (a.data.stock >= 2) return;
      a.data.rc = (a.data.rc ?? cooldownOf(a)) - dt;
      if (a.data.rc <= 0) { a.data.stock++; a.data.rc = cooldownOf(a); if (a.data.stock > 0) a.cd = 0; }
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const tgt = t.unit as Unit | undefined;
    if (!tgt && !hasTalent(u, 'special_bonus_unique_tiny_5')) { refund(a); return; }
    if (tgt === u) { refund(a); return; }
    const grabbed = w.unitsIn(u.x, u.y, val(a, 'grab_radius'), (v) => v !== u && v !== tgt && isUnitLike(v) && w.targetable(v) &&
      !v.has(ST.invulnerable) && !(v.team !== u.team && v.has(ST.magicImmune)))
      .sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))[0];
    if (!grabbed) { refund(a); return; }
    if (hasTalent(u, 'special_bonus_unique_tiny_2') && !a.temp) {
      a.data.stock = (a.data.stock ?? 2) - 1;
      a.data.rc ??= cooldownOf(a);
      a.cd = a.data.stock > 0 ? 0 : a.data.rc;
    }
    const ex = t.x, ey = t.y;
    const dest = (): [number, number] => (tgt && tgt.alive ? [tgt.x, tgt.y] : [ex, ey]);
    fly(grabbed, dest, val(a, 'duration'), u, a, 0, (v) => {
      const R = val(a, 'radius');
      const g = grow(u);
      const amount = (dmg(a, 'toss_damage') + (g ? val(g, 'toss_bonus_damage') : 0)) * (1 + val(a, 'toss_land_damage_pct') / 100);
      w.emit({ n: 'toss_land', x: v.x, y: v.y, r: R, t: u.team });
      for (const e of w.enemiesIn(u.team, v.x, v.y, R)) damage(u, e, amount, 'magical', a);
      shardLanding(u, v.x, v.y, R);
      w.cutTrees(v.x, v.y, R * 0.5);
    }, 'tossed');
  },
});

/** Árbol en la mano: más alcance, daño y golpes en área durante unos ataques. */
function treeSpec(a: AbilityInst) {
  return {
    name: 'tree_grab', stacks: val(a, 'attack_count'), fx: 'tree_grab',
    props: { damage: dmg(a, 'bonus_damage'), meleeRange: val(a, 'attack_range') },
    onAttackLanded(m: any, ev: any) {
      if (ev.fake) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      const d = Math.hypot(t.x - u.x, t.y - u.y) || 1;
      const amount = ev.damage * ev.critMult * val(a, 'splash_pct') / 100;
      for (const e of enemiesInLine(u, u.x, u.y, (t.x - u.x) / d, (t.y - u.y) / d, val(a, 'splash_range'), val(a, 'splash_width'))) {
        // Como el cleave: ignora la armadura.
        if (e !== t && e.kind !== 'ward') damage(u, e, amount, 'pure', a, { noProc: true });
      }
      m.stacks--;
      if (m.stacks <= 0) u.removeMod(m);
    },
  };
}

defineAbility({
  key: 'tiny_tree_grab', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const tree = u.w.nearestTree(u.x, u.y, val(a, 'abilitycastrange') + 150);
    if (!tree) { u.w.error(u, 'No hay árboles cerca'); refund(a); return; }
    u.w.cutTrees(tree.x, tree.y, 8);
    u.removeModsByName('tree_grab');
    u.addMod(treeSpec(a), u, a);
  },
});

defineAbility({
  key: 'tiny_toss_tree', target: 'unit', levelWith: 2, reflectable: true, ai: { role: 'nuke' },
  hidden: (a) => !(a.owner as Unit).findMod('tree_grab'),
  passive: (a) => ({ name: 'toss_tree_gate', onTick() { gate(a, !!(a.owner as Unit).findMod('tree_grab')); } }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const w = u.w;
    if (!u.findMod('tree_grab')) { refund(a); return; }
    u.removeModsByName('tree_grab');
    w.addProjectile({
      kind: 'track', fx: 'toss_tree', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'speed'), dodgeable: true,
      onHit() {
        const R = val(a, 'splash_radius');
        w.emit({ n: 'tree_land', x: e.x, y: e.y, r: R, t: u.team });
        for (const v of w.enemiesIn(u.team, e.x, e.y, R)) {
          if (v.kind === 'ward') continue;
          const ev = makeAttack(u, v, true);
          ev.damage += dmg(a, 'bonus_damage');
          if (v !== e) ev.trueStrike = true;
          landAttack(ev);
        }
        shardLanding(u, e.x, e.y, R);
        return true;
      },
    });
  },
});

defineAbility({
  key: 'tiny_tree_channel', target: 'point', ai: { role: 'channel' },
  aoe: (a) => val(a, 'splash_radius'),
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) { a.data.tx = t.x; a.data.ty = t.y; a.data.acc = val(a, 'interval'); },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const w = u.w;
    a.data.acc += dt;
    if (a.data.acc < val(a, 'interval')) return;
    a.data.acc -= val(a, 'interval');
    const tree = w.nearestTree(u.x + (w.rng() - 0.5) * 400, u.y + (w.rng() - 0.5) * 400, val(a, 'tree_grab_radius'));
    if (!tree) return;
    w.cutTrees(tree.x, tree.y, 8);
    const R = val(a, 'splash_radius');
    const ang = w.rng() * Math.PI * 2, rr = w.rng() * R * 0.5;
    const x = a.data.tx + Math.cos(ang) * rr, y = a.data.ty + Math.sin(ang) * rr;
    const d = Math.hypot(x - tree.x, y - tree.y);
    const tt = ability(u, 'tiny_toss_tree');
    w.emit({ n: 'lob', x: tree.x, y: tree.y, x2: x, y2: y, d: d / val(a, 'speed'), u: u.id });
    w.after(d / val(a, 'speed'), () => {
      w.emit({ n: 'tree_land', x, y, r: R, t: u.team });
      for (const v of w.enemiesIn(u.team, x, y, R)) {
        if (v.kind === 'ward' || (v.has(ST.magicImmune) && !a.def.bkbPierce)) continue;
        const ev = makeAttack(u, v, true);
        if (tt) ev.damage += dmg(tt, 'bonus_damage');
        landAttack(ev);
      }
      shardLanding(u, x, y, R);
    });
  },
});

defineAbility({
  key: 'tiny_insurmountable', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'insurmountable',
    props: (m) => {
      const str = (m.owner as Unit).s?.str ?? 0;
      return { statusResist: str * val(a, 'str_to_status_resist_pct') / 10000, slowResist: str * val(a, 'str_to_slow_resist_pct') / 10000 };
    },
  }),
});

defineAbility({
  key: 'tiny_grow', target: 'passive', ult: true,
  passive: (a) => ({
    name: 'grow', fx: 'grow',
    props: { armor: val(a, 'bonus_armor'), damage: dmg(a, 'bonus_damage'), attackSpeed: val(a, 'attack_speed_reduction'), msFlat: val(a, 'move_speed') },
  }),
});

defineHero('tiny', ['tiny_avalanche', 'tiny_toss', 'tiny_tree_grab', 'tiny_tree_channel', 'tiny_insurmountable', 'tiny_grow', 'tiny_toss_tree'], {
  build: ['phase_boots', 'magic_wand', 'blink', 'echo_sabre', 'black_king_bar', 'greater_crit', 'assault', 'ultimate_scepter'],
});

