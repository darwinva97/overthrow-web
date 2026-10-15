import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { creditHero, damage, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import { armorMult, type Unit } from '../sim/unit';
import { expire, helper, refund } from './lib/a8';
import { debuff, stun } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

function applyGush(u: Unit, e: Unit, a: AbilityInst) {
  damage(u, e, dmg(a, 'gush_damage'), 'magical', a);
  debuff(u, e, a, {
    name: 'gush', duration: dur(a, 'abilityduration'), fx: 'gush',
    props: { msSlow: Math.abs(val(a, 'movement_speed')) / 100, armor: -val(a, 'negative_armor') },
  });
}

defineAbility({
  key: 'tidehunter_gush', target: 'unitOrPoint', reflectable: true, ai: { role: 'disable' },
  castRange: (a) => (hasScepter(a.owner as Unit) ? val(a, 'cast_range_scepter') : val(a, 'abilitycastrange')),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    if (hasScepter(u) && !a.temp) {
      // Scepter: ola en línea con su propio enfriamiento.
      a.cd = val(a, 'cooldown_scepter') * a.upg.cd * (1 - u.s.cdr);
      let dx = t.x - u.x, dy = t.y - u.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      if (d < 2) { dx = Math.cos(u.facing); dy = Math.sin(u.facing); }
      w.addProjectile({
        kind: 'linear', fx: 'gush_wave', source: u, x: u.x, y: u.y, dx, dy,
        speed: val(a, 'speed_scepter'), left: val(a, 'cast_range_scepter') + u.s.castRange, width: val(a, 'aoe_scepter'),
        onHit(_p, e) { if (e.team !== u.team && e.kind !== 'ward' && !(e.has(ST.magicImmune))) applyGush(u, e as Unit, a); },
      });
      return;
    }
    const e = (t.unit as Unit | undefined) ?? w.enemiesIn(u.team, t.x, t.y, 150)[0];
    if (!e) { refund(a); return; }
    w.addProjectile({
      kind: 'track', fx: 'gush', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), dodgeable: true,
      onHit() { applyGush(u, e, a); return true; },
    });
  },
});

function anchorSmash(u: Unit, a: AbilityInst) {
  const R = u.s.attackRange + val(a, 'additional_range');
  u.w.emit({ n: 'anchor_smash', x: u.x, y: u.y, r: R, u: u.id, t: u.team });
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, R)) {
    if (e.kind === 'ward') continue;
    debuff(u, e, a, {
      name: 'anchor_smash', duration: val(a, 'reduction_duration'), fx: 'anchor_smash',
      onAttackStart(_m, ev) { ev.damage *= Math.max(0, 1 + val(a, 'damage_reduction') / 100); },
    });
    const ev = makeAttack(u, e, true);
    ev.damage += dmg(a, 'attack_damage');
    landAttack(ev);
  }
}

defineAbility({
  key: 'tidehunter_kraken_shell', target: 'none', ai: { role: 'buff', selfRadius: 500 },
  passive: (a) => ({
    name: 'kraken_shell', data: { acc: 0, last: -99 },
    onIncomingDamage(_m, ev) {
      const u = a.owner as Unit;
      if (!ev.isAttack || ev.type !== 'physical' || !ev.source || ev.source.team === u.team) return;
      let block = val(a, 'damage_reduction') * a.upg.dmg;
      if (u.findMod('kraken_shell_active')) block *= val(a, 'active_pct_effectiveness') / 100;
      if (!(ev.source as Unit).isHeroLike) block *= 1 - val(a, 'creep_reduction_penalty_pct') / 100;
      // El bloqueo es previo a la armadura; aquí el daño ya viene reducido.
      ev.amount = Math.max(0, ev.amount - block * armorMult(u.s.armor));
    },
    onTakeDamage(m, ev) {
      const u = m.owner as Unit;
      if (!ev.source || ev.source.team === u.team || !creditHero(ev.source as Unit)) return;
      if (u.w.time - m.data.last > val(a, 'damage_reset_interval')) m.data.acc = 0;
      m.data.last = u.w.time;
      m.data.acc += ev.amount;
      if (m.data.acc < val(a, 'damage_cleanse')) return;
      m.data.acc = 0;
      u.purge(true, false, true);
      u.w.emit({ n: 'kraken_cleanse', x: u.x, y: u.y, u: u.id });
      // Talento: la limpieza dispara Anchor Smash.
      const sm = ability(u, 'tidehunter_anchor_smash');
      if (val(a, 'smash_on_purge') > 0 && sm && sm.level > 0) anchorSmash(u, sm);
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({ name: 'kraken_shell_active', duration: val(a, 'active_duration'), fx: 'kraken_shell',
      props: { msSlow: val(a, 'active_move_speed_penalty_pct') / 100 } }, u, a);
  },
});

defineAbility({
  key: 'tidehunter_anchor_smash', target: 'none', ai: { role: 'aoe', selfRadius: 330 },
  aoe: (a) => (a.owner as Unit).s.attackRange + val(a, 'additional_range'),
  onSpellStart(a) { anchorSmash(a.owner as Unit, a); },
});

defineAbility({
  key: 'tidehunter_dead_in_the_water', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'dead_in_the_water', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), dodgeable: true,
      onHit() {
        if (!e.alive) return true;
        const D = val(a, 'duration');
        const anchor = helper(u, 'unit_tidehunter_anchor', e.x, e.y, D, ST.noCollision);
        anchor.addMod({
          name: 'anchor', persistent: true, fx: 'anchor', data: { hits: 0 },
          // Solo se rompe con ataques de héroe.
          onIncomingDamage(m, ev) {
            ev.amount = 0;
            if (!ev.isAttack || !(ev.source as Unit)?.isHeroLike) return;
            if (++m.data.hits >= val(a, 'attacks_to_destroy')) expire(anchor);
          },
        });
        const m = debuff(u, e, a, {
          name: 'dead_in_the_water', duration: D, fx: 'dead_in_the_water', data: { far: false },
          props: (mm) => (mm.data.far ? { msFixed: val(a, 'max_movement_speed') } : {}),
          onTick(mm) {
            if (!anchor.alive) { e.removeMod(mm); return; }
            const L = val(a, 'chain_length');
            const d = Math.hypot(e.x - anchor.x, e.y - anchor.y);
            const far = d >= L - 5;
            if (far !== mm.data.far) { mm.data.far = far; e.refreshStats(); }
            // Arrastra el ancla tras de sí.
            if (d > L) { anchor.x = e.x - (e.x - anchor.x) / d * L; anchor.y = e.y - (e.y - anchor.y) / d * L; }
          },
          onDestroy() { expire(anchor); },
        });
        if (!m) expire(anchor);
        return true;
      },
    });
  },
});

defineAbility({
  key: 'tidehunter_ravage', target: 'none', ult: true, ai: { role: 'disable', selfRadius: 700 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const cx = u.x, cy = u.y;
    const R = val(a, 'radius'), speed = val(a, 'speed');
    const hit = new Set<number>();
    let r = 0;
    w.emit({ n: 'ravage', x: cx, y: cy, r: R, d: R / speed, t: u.team });
    w.addZone({
      fx: '', x: cx, y: cy, r: 0, team: u.team, interval: 0.05, duration: R / speed + 0.1,
      onInterval() {
        r = Math.min(R, r + speed * 0.05);
        for (const e of w.enemiesIn(u.team, cx, cy, r)) {
          if (hit.has(e.id)) continue;
          hit.add(e.id);
          damage(u, e, dmg(a, 'abilitydamage'), 'magical', a);
          stun(u, e, dur(a, 'duration'), a);
        }
      },
    });
  },
});

// Innata oculta sin descripción en el parche (pesca de Crownfall): sin efecto en partida.
defineAbility({
  key: 'tidehunter_leviathans_catch', target: 'passive', innate: true,
  passive: () => null,
});

defineHero('tidehunter', ['tidehunter_gush', 'tidehunter_kraken_shell', 'tidehunter_anchor_smash', 'tidehunter_dead_in_the_water',
  'tidehunter_ravage', 'tidehunter_leviathans_catch'], {
  build: ['phase_boots', 'vanguard', 'blink', 'pipe', 'black_king_bar', 'shivas_guard', 'refresher'],
});
