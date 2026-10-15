import { defineAbility, defineHero, dmg, dur, hasScepter, manaCostOf, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import { armorMult, type Unit } from '../sim/unit';
import { abilityOf, attackDamage, knockFrom } from './lib/a0';
import { castDir, debuff, silence, slow } from './util';

/** Efecto de Frost Arrows sobre un objetivo: daño extra, ralentización y, con Scepter, Hypothermia. */
function frostHit(u: Unit, t: Unit, fa: AbilityInst): number {
  let bonus = dmg(fa, 'damage');
  slow(u, t, fa, 'frost_arrows', dur(fa, 'abilityduration'), Math.abs(val(fa, 'frost_arrows_movement_speed')) / 100);
  if (hasScepter(u) && val(fa, 'shard_max_stacks') > 0 && !(t.has(ST.magicImmune) && !fa.def.bkbPierce)) {
    const old = t.findMod('hypothermia', u);
    bonus += (old?.stacks ?? 0) * val(fa, 'shard_bonus_damage_per_stack');
    const stacks = Math.min(val(fa, 'shard_max_stacks'), (old?.stacks ?? 0) + 1);
    const m = debuff(u, t, fa, {
      name: 'hypothermia', duration: val(fa, 'shard_stack_duration'), stacks, fx: 'frostbite',
      props: (mm) => ({ hpRegenAmp: -mm.stacks * val(fa, 'shard_regen_reduction_pct_per_stack') / 100 }),
      // Al morir con cargas, estalla dañando y ralentizando alrededor.
      onDeath(mm) {
        const v = mm.owner as Unit;
        const r = val(fa, 'shard_burst_radius');
        u.w.emit({ n: 'nova', x: v.x, y: v.y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, v.x, v.y, r)) {
          damage(u, e, mm.stacks * val(fa, 'shard_burst_damage_per_stack'), 'magical', fa);
          slow(u, e, fa, 'hypothermia_burst', val(fa, 'shard_burst_slow_duration'), val(fa, 'shard_burst_move_slow_pct') / 100);
        }
      },
    });
    if (m) { m.stacks = stacks; t.refreshStats(); }
  }
  return bonus;
}

defineAbility({
  key: 'drow_ranger_frost_arrows', target: 'toggle', ai: { role: 'buff' },
  passive: (a) => ({
    name: 'frost_arrows',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit;
      if (!a.toggled || ev.fake || ev.target.team === u.team) return;
      const cost = manaCostOf(a);
      if (u.mana < cost || u.has(ST.silenced)) return;
      u.mana -= cost;
      (ev as any).frost = true;
    },
    onAttackLanded(_m, ev) {
      if (!(ev as any).frost) return;
      ev.damage += frostHit(ev.attacker as Unit, ev.target as Unit, a);
    },
  }),
});

defineAbility({
  key: 'drow_ranger_wave_of_silence', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = val(a, 'wave_length') + u.s.castRange;
    const sx = u.x, sy = u.y;
    u.w.addProjectile({
      kind: 'linear', fx: 'dragon_slave', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'wave_speed'), left: len, width: val(a, 'wave_width'),
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || v.kind === 'ward' || v.kind === 'fountain') return;
        if (v.has(ST.magicImmune) && !a.def.bkbPierce) return;
        const sd = dur(a, 'silence_duration');
        silence(u, v, sd, a, 'gust_silence');
        // Revela invisibles mientras dura el silencio.
        if (val(a, 'gust_reveals_invis') > 0) {
          debuff(u, v, a, { name: 'reveal', duration: sd, states: ST.revealed, data: { team: u.team } });
        }
        // Cuanto más cerca de Drow, más lejos los empuja.
        const k = Math.max(0, 1 - Math.hypot(v.x - sx, v.y - sy) / len);
        const kt = val(a, 'knockback_duration_min') + (val(a, 'knockback_duration') - val(a, 'knockback_duration_min')) * k;
        knockFrom(v, sx, sy, val(a, 'knockback_distance_max') * k, kt, u, a, 'gust_push');
      },
    });
    // Talento: Drow gana velocidad.
    const ms = val(a, 'bonus_movespeed');
    if (ms > 0) u.addMod({ name: 'gust_haste', duration: dur(a, 'silence_duration'), fx: 'haste', props: { msPct: ms / 100 } }, u, a);
  },
});

// Ráfagas de flechas en abanico. Drow puede moverse despacio y usar objetos mientras dura.
defineAbility({
  key: 'drow_ranger_multishot', target: 'point', ai: { role: 'aoe' },
  castRange: (a) => (a.owner as Unit).s.attackRange * val(a, 'arrow_range_multiplier') + val(a, 'arrow_range_base'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const base = Math.atan2(dy, dx);
    const total = val(a, 'abilitychanneltime');
    const waves = val(a, 'wave_count');
    const every = total / Math.max(1, waves);
    const fa = abilityOf(u, 'drow_ranger_frost_arrows');
    let fired = 0;
    const wave = () => {
      const n = val(a, 'arrow_count_per_wave');
      const spread = val(a, 'arrow_angle') * Math.PI / 180;
      const hit = new Set<number>();
      const range = u.s.attackRange * val(a, 'arrow_range_multiplier') + val(a, 'arrow_range_base');
      for (let i = 0; i < n; i++) {
        const ang = base + (n > 1 ? -spread / 2 + spread * i / (n - 1) : 0);
        u.w.addProjectile({
          kind: 'linear', fx: 'attack:drow_ranger', source: u, x: u.x, y: u.y, dx: Math.cos(ang), dy: Math.sin(ang),
          speed: val(a, 'arrow_speed'), left: range, width: val(a, 'arrow_width'),
          onHit(_p, e) {
            const v = e as Unit;
            if (v.team === u.team || v.kind === 'ward' || v.kind === 'fountain' || hit.has(v.id)) return false;
            hit.add(v.id);
            let amount = attackDamage(u) * val(a, 'arrow_damage_pct') / 100;
            if (fa && fa.level > 0) amount += frostHit(u, v, fa);
            damage(u, v, amount, 'physical', a);
            return true;
          },
        });
      }
    };
    u.addMod({
      name: 'multishot', duration: total + 0.05, fx: 'take_aim', states: ST.disarmed,
      props: { msSlow: 1 - val(a, 'multishot_movespeed') / 100 },
      onTick(m, dt) {
        // Se interrumpe como una canalización.
        if (u.has(ST.stunned) || u.has(ST.silenced) || u.has(ST.hexed)) { u.removeMod(m); return; }
        m.acc = (m.acc ?? 0) + dt;
        while (m.acc >= every && fired < waves) { m.acc -= every; fired++; wave(); }
      },
    }, u, a);
    fired++; wave();
  },
});

// Shard: colina de hielo; empuja a los enemigos y da alcance y visión aérea a quien está encima.
defineAbility({
  key: 'drow_ranger_glacier', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const x = u.x, y = u.y;
    const r = val(a, 'hilltop_offset') + val(a, 'ramp_radius') / 2;
    u.w.emit({ n: 'nova', x, y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, x, y, r)) knockFrom(e, x, y, val(a, 'knockback_distance'), val(a, 'knockback_duration'), u, a, 'glacier_push');
    u.w.addZone({
      fx: 'glacier', x, y, r, team: u.team, interval: 0.25, duration: val(a, 'shard_duration'),
      onInterval(z) {
        for (const al of u.w.alliesIn(u.team, z.x, z.y, z.r)) {
          const self = al === u;
          al.addMod({
            name: 'glacier_hill', duration: 0.35, states: ST.flying,
            props: { attackRange: self || !al.melee ? val(a, 'attack_range_bonus') : 0, damage: self ? val(a, 'damage_bonus') : 0 },
          }, u, a);
        }
      },
    });
  },
});

// Innata: agilidad extra según la suya; los héroes a distancia cercanos reciben la mitad.
defineAbility({
  key: 'drow_ranger_trueshot', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'trueshot', interval: 0.5, data: { bonus: 0 },
    props: (m) => ({ agi: m.data.bonus }),
    onInterval(m) {
      const u = m.owner as Unit;
      const bonus = Math.round((u.s.agi - m.data.bonus) * val(a, 'trueshot_agi_bonus') / 100);
      if (bonus !== m.data.bonus) { m.data.bonus = bonus; u.refreshStats(); }
    },
    aura: {
      radius: val(a, 'radius'), team: 'ally', heroesOnly: true, includeSelf: false,
      apply(m, t) {
        const share = t.melee ? 0 : m.data.bonus * val(a, 'trueshot_agi_bonus_allies_pct') / 100;
        return { name: 'trueshot_ally', props: { agi: Math.round(share) } };
      },
    },
  }),
});

defineAbility({
  key: 'drow_ranger_marksmanship', target: 'passive', ult: true,
  passive: (a) => ({
    name: 'marksmanship',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit;
      if (ev.target.team === u.team) return;
      // Se desactiva con un héroe enemigo cerca.
      const near = u.w.enemiesIn(u.team, u.x, u.y, val(a, 'disable_range'), { heroes: true }).some((e) => e.kind === 'hero');
      if (near || u.w.rng() >= val(a, 'chance') / 100) return;
      ev.damage += dmg(a, 'bonus_damage');
      (ev as any).marksman = true;
    },
    // La flecha ignora la armadura base del objetivo.
    onAttackLanded(_m, ev) {
      if (!(ev as any).marksman) return;
      const t = ev.target as Unit;
      const baseArmor = t.base.armor + (t.hero ? t.baseAttr('agi') / 6 : 0);
      const now = armorMult(t.s.armor);
      if (now > 0) ev.damage *= armorMult(t.s.armor - baseArmor) / now;
    },
  }),
});

defineHero('drow_ranger', [
  'drow_ranger_frost_arrows', 'drow_ranger_wave_of_silence', 'drow_ranger_multishot', 'drow_ranger_glacier',
  'drow_ranger_trueshot', 'drow_ranger_marksmanship',
], {
  build: ['wraith_band', 'power_treads', 'dragon_lance', 'black_king_bar', 'hurricane_pike', 'greater_crit', 'butterfly', 'satanic'],
});
