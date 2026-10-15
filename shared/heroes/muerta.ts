import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage, heal, landAttack, makeAttack } from '../sim/combat';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, push, silence, slow } from './util';
import { fear } from './lib/a5';

defineAbility({
  key: 'muerta_dead_shot', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  // Talento: cargas.
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), val(a, '_cd') * a.upg.cd * (1 - (a.owner as Unit).s.cdr)],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    // Sin vector targeting: el rebote sigue la dirección Muerta → objetivo.
    let dx = e.x - u.x, dy = e.y - u.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    u.w.addProjectile({
      kind: 'track', fx: 'dead_shot', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'speed'), dodgeable: false,
      onHit() {
        if (e.team !== u.team) {
          damage(u, e, dmg(a, 'damage'), 'magical', a);
          slow(u, e, a, 'dead_shot_slow', val(a, 'impact_slow_duration'), -val(a, 'impact_slow_percent') / 100);
        }
        const dist = Math.max(300, len) * val(a, 'ricochet_distance_multiplier');
        const pierces = val(a, 'scepter_pierces') > 0;
        const grow = val(a, 'ricochet_radius_expansion_per_second');
        const w0 = val(a, 'ricochet_radius_start') * 2;
        const w1 = grow > 0 ? w0 + grow * 2 * dist / val(a, 'speed') : val(a, 'ricochet_radius_end') * 2;
        u.w.addProjectile({
          kind: 'linear', fx: 'dead_shot', source: u, x: e.x, y: e.y, dx, dy, speed: val(a, 'speed'), left: dist,
          width: w0, widthEnd: w1, hit: new Set([e.id]),
          onHit(p, v) {
            const t2 = v as Unit;
            if (t2.team === u.team || t2.kind === 'ward' || (t2.has(ST.magicImmune) && !a.def.bkbPierce)) return false;
            damage(u, t2, dmg(a, 'damage'), 'magical', a);
            if (t2.alive) fear(u, t2, val(a, 'ricochet_fear_duration'), a, p.x - dx * 100, p.y - dy * 100, 'dead_shot_fear');
            // Con Scepter atraviesa héroes; si no, se detiene en el primero.
            return !(pierces && t2.isHeroLike);
          },
        });
        return true;
      },
    });
  },
});

defineAbility({
  key: 'muerta_the_calling', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'dead_zone_distance') + val(a, 'hit_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const R = val(a, 'dead_zone_distance');
    const n = val(a, 'num_revenants');
    const hitR = val(a, 'hit_radius');
    const hits = new Set<string>();
    let ang = 0, speed = val(a, 'speed_initial');
    const tick = 1 / 30;
    u.w.addZone({
      fx: 'the_calling', x: t.x, y: t.y, r: R + hitR, team: u.team, interval: tick, duration: dur(a, 'duration'),
      onInterval(z) {
        speed = Math.min(val(a, 'speed_max'), speed + val(a, 'acceleration') * tick);
        ang += val(a, 'rotation_direction') * speed * Math.PI * 2 * tick;
        for (let i = 0; i < n; i++) {
          const ra = ang + (i / n) * Math.PI * 2;
          const rx = z.x + Math.cos(ra) * R, ry = z.y + Math.sin(ra) * R;
          for (const e of u.w.enemiesIn(u.team, rx, ry, hitR)) {
            const k = `${i}:${e.id}`;
            if (hits.has(k)) continue;
            hits.add(k);
            damage(u, e, dmg(a, 'damage'), 'magical', a);
            silence(u, e, val(a, 'silence_duration'), a, 'the_calling_silence');
          }
        }
        if (u.w.tickN % 6) return;
        for (const e of u.w.enemiesIn(u.team, z.x, z.y, z.r)) {
          slow(u, e, a, 'the_calling_slow', 0.3, -val(a, 'aura_movespeed_slow') / 100);
        }
        // Talento: los aliados dentro regeneran un % de vida.
        const regen = val(a, 'hp_regen_pct');
        if (regen > 0) for (const al of u.w.alliesIn(u.team, z.x, z.y, z.r, { heroes: true })) heal(al, al.s.maxHp * regen / 100 * 0.2, u, true);
      },
    });
  },
});

// Pasiva: probabilidad de disparar dos veces (el segundo a otro objetivo cercano si lo hay).
defineAbility({
  key: 'muerta_gunslinger', target: 'passive',
  passive: (a) => ({
    name: 'gunslinger',
    props: { damage: val(a, 'bonus_damage') },
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit;
      if (ev.fake || u.w.rng() >= val(a, 'double_shot_chance') / 100) return;
      const r = u.s.attackRange + val(a, 'target_search_bonus_range');
      const others = u.w.enemiesIn(u.team, u.x, u.y, r).filter((e) => e !== ev.target && e.kind !== 'ward' && u.w.canSee(u.team, e))
        .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike));
      const t2 = others[0] ?? (ev.target as Unit);
      u.w.after(0.1, () => {
        if (!u.alive || !t2.alive) return;
        const ev2 = makeAttack(u, t2, true);
        u.w.addProjectile({
          kind: 'track', fx: 'attack:muerta', source: u, target: t2, x: u.x, y: u.y, speed: u.base.projSpeed, dodgeable: true,
          onHit() { landAttack(ev2); return true; },
        });
      });
    },
  }),
});

// Shard: bala espectral que empuja y vuelve etéreo al objetivo.
defineAbility({
  key: 'muerta_spectral_slug', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'spectral_slug', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), dodgeable: true,
      onHit() {
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        if (!e.alive) return true;
        // No la saca del alcance de ataque de Muerta.
        const d = Math.hypot(e.x - u.x, e.y - u.y);
        const kb = Math.max(0, Math.min(val(a, 'knockback_distance'), u.s.attackRange - d));
        if (kb > 0) push(e, e.x - u.x, e.y - u.y, kb, val(a, 'knockback_duration'), u, a, 'spectral_slug_push');
        // El estado etéreo del motor ya amplifica el daño mágico; no se suma la amplificación del dataset.
        debuff(u, e, a, {
          name: 'spectral_slug', duration: val(a, 'duration'), fx: 'ethereal',
          states: ST.ethereal | ST.disarmed, props: { msSlow: -val(a, 'slow_pct') / 100 },
        });
        return true;
      },
    });
  },
});

defineAbility({
  key: 'muerta_pierce_the_veil', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const pct = val(a, 'base_damage_percent') / 100;
    u.addMod({
      name: 'pierce_the_veil', duration: dur(a, 'duration') + val(a, 'transform_duration'), fx: 'pierce_the_veil',
      // Inmune al daño físico; sus ataques hacen daño mágico.
      onIncomingDamage(_m, ev) { if (ev.type === 'physical' && !ev.hpRemoval) ev.amount = 0; },
      onAttackLanded(_m, ev) {
        const amount = ev.damage * ev.critMult * pct;
        ev.damage = 0;
        damage(u, ev.target as Unit, amount, 'magical', a);
      },
    }, u, a);
  },
});

// Innata (aproximación): amplificación de hechizos por cada héroe enemigo cercano.
defineAbility({
  key: 'muerta_supernatural', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'supernatural', interval: 0.5,
    props: (m) => ({ spellAmp: (m.data.n ?? 0) * val(a, 'spell_amp_per_stack') / 100 }),
    onInterval(m) {
      const u = m.owner as Unit;
      const n = Math.min(val(a, 'max_stacks'), u.w.enemiesIn(u.team, u.x, u.y, val(a, 'stack_collection_range'), { heroes: true })
        .filter((e) => e.kind === 'hero').length);
      if (n !== m.data.n) { m.data.n = n; u.refreshStats(); }
    },
  }),
});

defineHero('muerta', ['muerta_dead_shot', 'muerta_the_calling', 'muerta_gunslinger', 'muerta_spectral_slug', 'muerta_pierce_the_veil', 'muerta_supernatural'], {
  build: ['wraith_band', 'power_treads', 'maelstrom', 'dragon_lance', 'black_king_bar', 'greater_crit', 'satanic'],
});

