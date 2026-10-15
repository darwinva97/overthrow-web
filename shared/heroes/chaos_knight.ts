import { defineAbility, defineHero, dmg, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { illusionsOf, stun } from './util';

/** Ilusión de CK; con Scepter, 50% de crear otra más. */
function ckIllusions(u: Unit, x: number, y: number, duration: number, out: number, inc: number, count: number, target?: Unit) {
  const hero = u.kind === 'illusion' ? (u.owner as Unit) : u;
  const ph = hero.abilities.find((a) => a.key === 'chaos_knight_phantasm');
  let n = count;
  if (ph && hasScepter(hero)) {
    for (let i = 0; i < count; i++) if (u.w.rng() < val(ph, 'bonus_illusion_chance') / 100) n += val(ph, 'bonus_illusion_count');
  }
  const out_: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const ang = u.w.rng() * Math.PI * 2;
    const il = u.w.spawnIllusion(hero, x + Math.cos(ang) * 100, y + Math.sin(ang) * 100, duration, out / 100, inc / 100);
    if (target) u.w.issueOrder(il, { type: 'attack', target: target.id });
    out_.push(il);
  }
  return out_;
}

defineAbility({
  key: 'chaos_knight_chaos_bolt', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'chaos_bolt', source: u, target: e, x: u.x, y: u.y,
      speed: val(a, 'chaos_bolt_speed'), dodgeable: true,
      onHit() {
        if (e.team !== u.team && e.has(ST.magicImmune)) return true;
        // Aturdimiento y daño inversamente relacionados, como en Dota.
        const r = u.w.rng();
        const st = val(a, 'stun_min') + (val(a, 'stun_max') - val(a, 'stun_min')) * r;
        const dm = (val(a, 'damage_max') - (val(a, 'damage_max') - val(a, 'damage_min')) * r) * a.upg.dmg;
        u.w.emit({ n: 'chaos_bolt', x: e.x, y: e.y, u: e.id, v: Math.round(st * 10) / 10 });
        damage(u, e, dm, 'magical', a);
        stun(u, e, st * a.upg.dur, a);
        // Shard: un Phantasm ataca al objetivo.
        if (hasShard(u) && !a.temp && e.team !== u.team && val(a, 'illusion_duration') > 0) {
          const ph = u.abilities.find((x) => x.key === 'chaos_knight_phantasm');
          const inc = ph && ph.level > 0 ? val(ph, 'incoming_damage') : 250;
          ckIllusions(u, e.x, e.y, val(a, 'illusion_duration'), -val(a, 'illusion_damage_reduction_pct'), inc, 1, e);
        }
        return true;
      },
    });
  },
});

defineAbility({
  key: 'chaos_knight_reality_rift', target: 'unit', reflectable: true, ai: { role: 'disable' },
  // El talento hace que atraviese inmunidad: se marca en la instancia.
  passive: (a) => { a.data.pierce = val(a, 'pierces_immunity') > 0; return null; },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const pierce = !!a.data.pierce;
    if (e.has(ST.magicImmune) && e.team !== u.team && !pierce) return;
    const d = Math.hypot(u.x - e.x, u.y - e.y) || 1;
    const nx = (u.x - e.x) / d, ny = (u.y - e.y) / d;
    const pull = Math.min(val(a, 'pull_distance'), Math.max(0, d - 120));
    const px = e.x + nx * pull, py = e.y + ny * pull;
    u.w.emit({ n: 'reality_rift', x: u.x, y: u.y, x2: px, y2: py, u: u.id, u2: e.id });
    if (e.cast?.phase === 2) e.w.interruptCast(e, true);
    u.w.teleport(e, px, py);
    const group = a.temp ? [u] : [u, ...illusionsOf(u.kind === 'illusion' ? u.owner as Unit : u)];
    group.forEach((g, i) => {
      const ang = Math.atan2(ny, nx) + (i ? (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.6 : 0);
      u.w.teleport(g, px + Math.cos(ang) * 110, py + Math.sin(ang) * 110);
      g.facing = Math.atan2(py - g.y, px - g.x);
      if (g !== u) u.w.issueOrder(g, { type: 'attack', target: e.id });
    });
    if (e.team !== u.team) {
      e.addMod({
        name: 'reality_rift', duration: val(a, 'duration'), debuff: true, fx: 'armor_down',
        props: { armor: -val(a, 'armor_reduction') },
      }, u, a);
    }
  },
});

defineAbility({
  key: 'chaos_knight_chaos_strike', target: 'passive',
  passive: (a) => ({
    name: 'chaos_strike',
    onAttackStart(m, ev) {
      m.data.crit = false;
      if ((ev.attacker as Unit).w.rng() >= val(a, 'chance') / 100) return;
      const u = ev.attacker as Unit;
      const mult = (val(a, 'crit_min') + u.w.rng() * (val(a, 'crit_max') - val(a, 'crit_min'))) / 100;
      if (mult > ev.critMult) { ev.critMult = mult; m.data.crit = true; }
    },
    onDealDamage(m, ev) {
      if (!ev.isAttack || !ev.crit || !m.data.crit) return;
      m.data.crit = false;
      const u = m.owner as Unit;
      const t = ev.target as Unit;
      const mult = t.isHeroLike ? 1 : val(a, 'creep_multiplier');
      heal(u, ev.amount * val(a, 'lifesteal') / 100 * mult, u, true);
    },
  }),
});

/** Fundamental Forging: el reparto de atributos por nivel es aleatorio (misma suma total). */
defineAbility({
  key: 'chaos_knight_fundamental_forging', target: 'passive', innate: true, noIllusion: true,
  passive: (a: AbilityInst) => ({
    name: 'fundamental_forging', interval: 0.5,
    onInterval(m) {
      const u = m.owner as Unit;
      if (u.kind !== 'hero' || !u.hero) return;
      a.data.lvl ??= 1;
      let changed = false;
      while (a.data.lvl < u.level) {
        a.data.lvl++;
        const h = u.hero;
        const total = h.strGain + h.agiGain + h.intGain;
        const r = [u.w.rng(), u.w.rng(), u.w.rng()];
        const s = r[0] + r[1] + r[2] || 1;
        u.permStr += total * r[0] / s - h.strGain;
        u.permAgi += total * r[1] / s - h.agiGain;
        u.permInt += total * r[2] / s - h.intGain;
        changed = true;
      }
      if (changed) { u.refreshStats(); m.stacks = a.data.lvl; }
    },
  }),
});

defineAbility({
  key: 'chaos_knight_phantasm', target: 'none', ult: true, ai: { role: 'summon', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.purge(true, false);
    u.w.disjoint(u);
    const delay = val(a, 'invuln_duration');
    u.addMod({ name: 'phantasm_cast', duration: delay, states: ST.invulnerable | ST.hidden | ST.untargetable, fx: 'phantasm' }, u, a);
    u.order = null;
    u.w.after(delay, () => {
      if (!u.alive) return;
      const out = val(a, 'outgoing_damage'), inc = val(a, 'incoming_damage');
      ckIllusions(u, u.x, u.y, val(a, 'illusion_duration'), out, inc, val(a, 'images_count'));
      // Scepter: también una ilusión de cada héroe aliado, esté donde esté.
      if (hasScepter(u)) {
        for (const al of u.w.list) {
          if (al === u || al.kind !== 'hero' || al.team !== u.team || !al.alive) continue;
          u.w.spawnIllusion(al, al.x + 80, al.y, val(a, 'illusion_duration'), out / 100, inc / 100);
        }
      }
    });
  },
});

defineHero('chaos_knight', ['chaos_knight_chaos_bolt', 'chaos_knight_reality_rift', 'chaos_knight_chaos_strike', 'chaos_knight_fundamental_forging', 'chaos_knight_phantasm'], {
  build: ['bracer', 'power_treads', 'armlet', 'blink', 'black_king_bar', 'heart', 'assault', 'satanic'],
  upgrades: [
    { slot: 0, key: 'damage_max', amount: 40, max: 5, label: 'Chaos Bolt: +40 daño máximo' },
    { slot: 1, key: 'armor_reduction', amount: 1, max: 5, label: 'Reality Rift: −1 armadura' },
    { slot: 2, key: 'chance', amount: 3, max: 5, label: 'Chaos Strike: +3% probabilidad' },
    { slot: 2, key: 'lifesteal', amount: 10, max: 5, label: 'Chaos Strike: +10% robo de vida' },
    { slot: 4, key: 'images_count', amount: 1, max: 2, label: 'Phantasm: +1 ilusión' },
  ],
});
