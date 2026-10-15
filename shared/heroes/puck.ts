import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, giveMana, heal, launchAttack } from '../sim/combat';
import type { Projectile } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, silence, stun } from './util';
import { abil, gate } from './lib/a6';

/** Esquiva proyectiles (Phase Shift, Ethereal Jaunt) y aplica Puckish por cada uno. */
function puckDisjoint(u: Unit) {
  let attacks = 0, spells = 0;
  for (const p of u.w.projectiles) {
    if (p.dead || p.kind !== 'track' || p.target !== u || !p.dodgeable || p.team === u.team) continue;
    if (p.fx.startsWith('attack')) attacks++; else spells++;
  }
  u.w.disjoint(u);
  const pk = abil(u, 'puck_puckish');
  if (!pk || pk.level <= 0 || (!attacks && !spells) || u.has(ST.broken)) return;
  const pct = val(pk, 'mana_and_health_restore_pct') / 100 * (attacks + spells * val(pk, 'dodged_spell_multiplier'));
  heal(u, u.s.maxHp * pct, u);
  giveMana(u, u.s.maxMana * pct);
}

defineAbility({
  key: 'puck_illusory_orb', target: 'point', castBeyond: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const r = val(a, 'radius');
    const impact = dmg(a, 'damage');
    const every = val(a, 'damage_interval');
    let acc = 0;
    const jaunt = abil(u, 'puck_ethereal_jaunt');
    const orb: Projectile = u.w.addProjectile({
      kind: 'linear', fx: 'illusory_orb', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'orb_speed'), left: val(a, 'max_distance') * a.upg.range, width: r * 2,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.has(ST.magicImmune)) return false;
        damage(u, v, impact, 'magical', a);
        return false;
      },
      onThink(p, dt) {
        // Daño residual en su área cada medio segundo y visión a su paso.
        acc += dt;
        // Bots: saltan al orbe al final de su recorrido.
        if (u.isBot && jaunt && jaunt.level > 0 && p.left < 250 && a.data.orb === p.id && u.alive && !u.cast) {
          u.w.issueOrder(u, { type: 'cast', slot: jaunt.slot });
        }
        if (acc < every) return;
        acc -= every;
        u.w.addVision(u.team, p.x, p.y, val(a, 'orb_vision'), val(a, 'vision_duration'));
        for (const e of u.w.enemiesIn(u.team, p.x, p.y, r, { immune: false })) {
          damage(u, e, impact * val(a, 'damage_over_time_pct') / 100, 'magical', a, { noProc: true });
        }
      },
      onEnd() { if (a.data.orb === orb.id) { a.data.orb = 0; gate(jaunt, false); } },
    });
    a.data.orb = orb.id;
    a.data.orbRef = orb;
    gate(jaunt, true);
  },
});

defineAbility({
  key: 'puck_waning_rift', target: 'point', castBeyond: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  castRange: (a) => val(a, 'max_distance'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const d = Math.min(castRangeOf(a), Math.hypot(t.x - u.x, t.y - u.y));
    u.w.emit({ n: 'blink', x: u.x, y: u.y, u: u.id });
    u.w.teleport(u, u.x + dx * d, u.y + dy * d);
    const r = val(a, 'radius');
    u.w.emit({ n: 'waning_rift', x: u.x, y: u.y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      damage(u, e, dmg(a, 'damage'), 'magical', a);
      silence(u, e, dur(a, 'silence_duration'), a, 'waning_rift');
    }
  },
});

defineAbility({
  key: 'puck_phase_shift', target: 'none', ai: { role: 'escape', selfRadius: 350 },
  channel: (a) => val(a, 'duration'),
  passive: (a) => (hasShard(a.owner as Unit) ? {
    // Shard: daño mágico extra en los ataques.
    name: 'phase_shift_shard',
    onAttackLanded(_m, ev) {
      if (ev.missed) return;
      damage(ev.attacker as Unit, ev.target as Unit, val(a, 'shard_bonus_damage'), 'magical', a, { noProc: true });
    },
  } : null),
  onSpellStart(a) {
    const u = a.owner as Unit;
    puckDisjoint(u);
    u.addMod({
      name: 'phase_shift', duration: val(a, 'duration'), fx: 'phase_shift',
      // Sin ST.hidden: el motor corta las canalizaciones de unidades ocultas.
      states: ST.invulnerable | ST.untargetable | ST.noCollision,
    }, u, a);
    // Shard: ataca a todos los enemigos a su alcance al desaparecer.
    if (hasShard(u)) {
      const range = u.s.attackRange + val(a, 'shard_attack_range_bonus');
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, range)) if (u.w.canSee(u.team, e)) launchAttack(u, e, true);
    }
  },
  onChannelEnd(a) { (a.owner as Unit).removeModsByName('phase_shift'); },
});

defineAbility({
  key: 'puck_ethereal_jaunt', target: 'none', levelWith: 0,
  hidden: (a) => !abil(a.owner as Unit, 'puck_illusory_orb')?.data.orb,
  onSpellStart(a) {
    const u = a.owner as Unit;
    const orbA = abil(u, 'puck_illusory_orb');
    const p = orbA?.data.orbRef as Projectile | undefined;
    if (!orbA || !p || p.dead || orbA.data.orb !== p.id) { gate(a, false); return; }
    puckDisjoint(u);
    u.w.emit({ n: 'blink', x: u.x, y: u.y, u: u.id });
    u.w.teleport(u, p.x, p.y);
    p.dead = true;
    orbA.data.orb = 0;
    gate(a, false);
  },
});

defineAbility({
  key: 'puck_puckish', target: 'passive', innate: true,
  passive: () => null,
});

defineAbility({
  key: 'puck_dream_coil', target: 'point', ult: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'coil_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const cx = t.x, cy = t.y;
    const durC = dur(a, 'coil_duration');
    u.w.emit({ n: 'dream_coil', x: cx, y: cy, r: val(a, 'coil_radius'), d: durC, t: u.team });
    const rapid = hasScepter(u) && val(a, 'attack_rate_pct') > 0;
    for (const e of u.w.enemiesIn(u.team, cx, cy, val(a, 'coil_radius'), { heroes: true, immune: false })) {
      damage(u, e, dmg(a, 'coil_initial_damage'), 'magical', a);
      stun(u, e, val(a, 'stun_duration'), a);
      if (!e.alive) continue;
      e.addMod({
        name: 'dream_coil', duration: durC, debuff: true, purgable: false, fx: 'dream_coil', data: { multi: true, acc: 0 },
        onTick(m, dt) {
          const v = m.owner as Unit;
          // Scepter: Puck le ataca desde la espiral.
          if (rapid && u.alive) {
            m.data.acc += dt;
            const every = u.attackInterval() / (val(a, 'attack_rate_pct') / 100);
            if (m.data.acc >= every) { m.data.acc -= every; launchAttack(u, v, true); }
          }
          if (m.data.broken) return;
          if (Math.hypot(v.x - cx, v.y - cy) > val(a, 'coil_break_radius')) {
            m.data.broken = true;
            u.w.emit({ n: 'dream_coil_break', x: v.x, y: v.y, u: v.id });
            damage(u, v, dmg(a, 'coil_break_damage'), 'magical', a);
            stun(u, v, dur(a, 'coil_stun_duration'), a);
            if (rapid) m.remaining = Math.max(m.remaining, dur(a, 'coil_stun_duration'));
            else m.remaining = 0.001;
          }
        },
      }, u, a);
    }
  },
});

defineHero('puck', ['puck_illusory_orb', 'puck_waning_rift', 'puck_phase_shift', 'puck_ethereal_jaunt', 'puck_puckish', 'puck_dream_coil'], {
  build: ['null_talisman', 'power_treads', 'witch_blade', 'blink', 'kaya_and_sange', 'black_king_bar', 'ultimate_scepter', 'octarine_core'],
});
