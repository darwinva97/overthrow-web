import { castRangeOf, defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { damage, giveMana, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, push } from './util';
import { botCast, nearestEnemyHero } from './lib/a3';

const abil = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
const inSpiritForm = (u: Unit) => !!u.findMod('spirit_form');

/** Suelta la ola de Illuminate con la potencia cargada hasta ahora. */
function releaseIlluminate(a: AbilityInst) {
  const u = a.owner as Unit;
  const d = a.data;
  if (!d.charging) return;
  d.charging = false;
  const max = val(a, 'max_channel_time');
  const power = Math.max(0, Math.min(1, (u.w.time - d.start) / max));
  const total = dmg(a, 'total_damage') * power;
  const healPct = d.spirit ? val(abil(u, 'keeper_of_the_light_spirit_form') ?? a, 'illuminate_heal') / 100 : 0;
  const r = val(a, 'radius');
  const vr = val(a, 'vision_radius'), vd = val(a, 'vision_duration');
  let acc = 0;
  u.w.addProjectile({
    kind: 'linear', fx: 'dragon_slave', source: u, x: d.x, y: d.y, dx: d.dx, dy: d.dy,
    speed: val(a, 'speed'), left: val(a, 'range'), width: r * 2,
    onThink(p, dt) {
      acc += dt;
      if (acc >= 0.25) { acc = 0; u.w.addVision(u.team, p.x, p.y, vr, vd, false); }
    },
    onHit(_p, e) {
      const v = e as Unit;
      if (v.kind === 'ward') return;
      if (v.team !== u.team) damage(u, v, total, 'magical', a);
      else if (healPct > 0 && (v.isHeroLike || v.kind === 'creep' || v.kind === 'summon')) heal(v, total * healPct, u);
    },
  });
}

defineAbility({
  key: 'keeper_of_the_light_illuminate', target: 'point', ai: { role: 'nuke' },
  // En Spirit Form lo canaliza un espíritu y Keeper queda libre.
  channel: (a) => (inSpiritForm(a.owner as Unit) ? 0 : val(a, 'max_channel_time')),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const spirit = inSpiritForm(u);
    a.data = { charging: true, start: u.w.time, x: u.x, y: u.y, dx, dy, spirit, vAcc: 0, vStep: 0 };
    if (spirit) {
      u.addMod({
        name: 'illuminate_spirit', duration: val(a, 'max_channel_time'), fx: 'fade', interval: val(a, 'channel_vision_interval'),
        onInterval() { illuminateVision(a); },
        onDestroy() { releaseIlluminate(a); },
      }, u, a);
    }
  },
  onChannelTick(a, dt) {
    a.data.vAcc += dt;
    if (a.data.vAcc >= val(a, 'channel_vision_interval')) { a.data.vAcc = 0; illuminateVision(a); }
  },
  onChannelEnd(a) { releaseIlluminate(a); },
});

/** Visión que avanza por el camino mientras se carga. */
function illuminateVision(a: AbilityInst) {
  const u = a.owner as Unit;
  const d = a.data;
  d.vStep++;
  const k = val(a, 'channel_vision_step') * d.vStep;
  u.w.addVision(u.team, d.x + d.dx * k, d.y + d.dy * k, val(a, 'channel_vision_radius'), val(a, 'channel_vision_duration'), false);
}

defineAbility({
  key: 'keeper_of_the_light_blinding_light', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.emit({ n: 'nova', x: t.x, y: t.y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
      damage(u, e, dmg(a, 'damage'), 'magical', a);
      if (!e.alive) continue;
      // Empuje hasta el borde del área (mínimo knockback_distance).
      const d = Math.hypot(e.x - t.x, e.y - t.y);
      const dx = d < 1 ? e.x - u.x : e.x - t.x, dy = d < 1 ? e.y - u.y : e.y - t.y;
      if (e.team !== u.team && (!e.has(ST.magicImmune) || a.def.bkbPierce)) {
        push(e, dx, dy, Math.max(val(a, 'knockback_distance'), r - d), val(a, 'knockback_duration'), u, a, 'blinding_light_knockback');
      }
      const miss = val(a, 'miss_rate') / 100;
      // Ceguera: el ataque falla (aproximación: daño 0, los efectos de impacto siguen saltando).
      debuff(u, e, a, {
        name: 'blinding_light', duration: dur(a, 'duration'), fx: 'slow',
        onAttackStart(mm, ev) {
          const v = mm.owner as Unit;
          if (v.w.rng() >= miss) return;
          ev.missed = true; ev.damage = 0; ev.critMult = 1;
          v.w.emit({ n: 'miss', x: ev.target.x, y: ev.target.y, u: ev.target.id });
        },
      });
    }
  },
});

defineAbility({
  key: 'keeper_of_the_light_chakra_magic', target: 'unit', team: 'ally', allowSelf: true,
  // Los bots lo lanzan sobre sí mismos o el aliado con menos maná.
  passive: (a) => botCast(a, (u) => {
    let best: Unit | null = null, bp = 0.55;
    for (const al of u.w.alliesIn(u.team, u.x, u.y, castRangeOf(a) + 200, { heroes: true })) {
      if (al.kind !== 'hero' || al.s.maxMana <= 0) continue;
      const p = al.mana / al.s.maxMana;
      if (p < bp) { bp = p; best = al; }
    }
    return best;
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const k = e === u ? 1 + val(a, 'self_bonus') / 100 : 1;
    giveMana(e, val(a, 'mana_restore') * a.upg.dmg * k);
    const red = val(a, 'cooldown_reduction') * k;
    for (const x of e.abilities) if (!x.impl.ult && !x.def.ult && x.cd > 0) x.cd = Math.max(0, x.cd - red);
    if (val(a, 'strong_dispel') > 0) e.purge(true, false, true);
    u.w.emit({ n: 'arcane_boots', x: e.x, y: e.y, u: e.id });
  },
});

// Solar Bind: sigue el nivel de Spirit Form; con Shard, dos cargas.
defineAbility({
  key: 'keeper_of_the_light_radiant_bind', target: 'unit', reflectable: true, levelWith: 5, ai: { role: 'disable' },
  charges: (a) => {
    const u = a.owner as Unit;
    if (hasShard(u)) return [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')];
    return [1, val(a, 'abilitychargerestoretime') || val(a, '_cd') * (1 - u.s.cdr)];
  },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const base = val(a, 'slow') / 100;
    // El ralentizado crece con la distancia recorrida (aprox.: ×(1 + recorrido/300), hasta ×5).
    debuff(u, e, a, {
      name: 'radiant_bind', duration: dur(a, 'duration'), fx: 'slow', data: { moved: 0, lx: e.x, ly: e.y },
      props: (m) => ({ magicResist: -val(a, 'magic_resistance') / 100, msSlow: base * Math.min(5, 1 + m.data.moved / 300) }),
      onTick(m) {
        const v = m.owner as Unit;
        const step = Math.hypot(v.x - m.data.lx, v.y - m.data.ly);
        m.data.lx = v.x; m.data.ly = v.y;
        if (step > 0 && step < 200) { m.data.moved += step; v.refreshStats(); }
      },
    });
    if (val(a, 'stun_duration') > 0) debuff(u, e, a, { name: 'stunned', duration: val(a, 'stun_duration'), states: ST.stunned, fx: 'stun' });
  },
});

// Ignis Fatuus (Scepter): alterna encendido/apagado e hipnotiza a los enemigos cercanos.
defineAbility({
  key: 'keeper_of_the_light_will_o_wisp', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const onD = val(a, 'on_duration'), offD = val(a, 'off_duration'), first = val(a, 'off_duration_initial');
    const count = val(a, 'on_count');
    const total = first + count * onD + (count - 1) * offD;
    const wisp = w.addUnit('ward', 'keeper_of_the_light_wisp', u.team, {
      hp: val(a, 'hit_count'), hpRegen: 0, mana: 0, manaRegen: 0, armor: 0, mr: 0, dmgMin: 0, dmgMax: 0,
      bat: 1, attackPoint: 0, range: 0, projSpeed: 0, ms: 0, dayVision: 400, nightVision: 400, turnRate: 1, melee: true,
    }, t.x, t.y);
    wisp.owner = u;
    wisp.playerId = u.playerId;
    wisp.expireAt = w.time + total;
    wisp.bountyGold = val(a, 'bounty');
    wisp.hp = wisp.s.maxHp;
    wisp.addMod({
      name: 'will_o_wisp', persistent: true, fx: 'radiance', states: ST.disarmed | ST.flying | ST.noCollision,
      // Solo se mata a golpes: cada ataque quita un golpe; los hechizos no le hacen nada.
      onIncomingDamage(_m, ev) { ev.amount = ev.isAttack ? 1 : 0; },
    }, u, a);
    const r = val(a, 'radius');
    const flash = (n: number) => {
      if (!wisp.alive) return;
      w.emit({ n: 'nova', x: wisp.x, y: wisp.y, r, t: u.team });
      for (const e of w.enemiesIn(u.team, wisp.x, wisp.y, r)) {
        if (e.kind === 'ward') continue;
        damage(u, e, dmg(a, 'wisp_damage'), 'magical', a);
        if (!e.alive) continue;
        const m = debuff(u, e, a, {
          name: 'will_o_wisp_hypnotize', duration: onD, fx: 'taunt',
          states: ST.busy | ST.disarmed | ST.silenced | ST.muted,
          onTick(mm, dt) {
            const v = mm.owner as Unit;
            const d = Math.hypot(wisp.x - v.x, wisp.y - v.y);
            if (d < 80 || !wisp.alive) return;
            const step = val(a, 'fixed_movement_speed') * dt;
            v.facing = Math.atan2(wisp.y - v.y, wisp.x - v.x);
            v.w.forceMove(v, v.x + (wisp.x - v.x) / d * step, v.y + (wisp.y - v.y) / d * step);
          },
        });
        if (m && e.cast) w.interruptCast(e, true);
      }
      if (n + 1 < count) w.after(onD + offD, () => flash(n + 1));
    };
    w.after(first, () => flash(0));
  },
});

defineAbility({
  key: 'keeper_of_the_light_spirit_form', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 1000 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'spirit_form', duration: dur(a, 'duration'), fx: 'haste',
      props: { castRange: val(a, 'cast_range') },
    }, u, a);
    u.refreshStats();
  },
});

// Suelta Illuminate antes de tiempo (canalizado o cargado por el espíritu).
defineAbility({
  key: 'keeper_of_the_light_illuminate_end', target: 'none', levelWith: 0, sub: true,
  hidden: (a) => !abil(a.owner as Unit, 'keeper_of_the_light_illuminate')?.data.charging,
  passive: (a) => ({
    name: 'illuminate_end_bot', interval: 0.3,
    onInterval(m) {
      const u = m.owner as Unit;
      const il = abil(u, 'keeper_of_the_light_illuminate');
      if (!u.isBot || !il?.data.charging || u.w.castCheck(u, a)) return;
      // Bots: sueltan pronto si el enemigo está cerca del camino; si no, cargan del todo.
      const held = u.w.time - il.data.start;
      if (held >= 1.6 && nearestEnemyHero(u, 700)) u.w.issueOrder(u, { type: 'cast', slot: a.slot });
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const il = abil(u, 'keeper_of_the_light_illuminate');
    if (!il?.data.charging) return;
    if (u.cast && u.cast.a === il) u.w.interruptCast(u, false);
    else {
      const sp = u.findMod('illuminate_spirit');
      if (sp) u.removeMod(sp);
      else releaseIlluminate(il);
    }
  },
});

// +1 de velocidad por cada `intelligence_per_speed` de inteligencia (más en Spirit Form) y rastro de visión.
defineAbility({
  key: 'keeper_of_the_light_bright_speed', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'bright_speed', interval: 0.5, data: { moved: 0, lx: NaN, ly: NaN },
    props: (m) => {
      const u = m.owner as Unit;
      if (!u) return {};
      const sf = abil(u, 'keeper_of_the_light_spirit_form');
      const k = sf && inSpiritForm(u) ? 1 + val(sf, 'movement_speed') / 100 : 1;
      return { msFlat: u.s.int / val(a, 'intelligence_per_speed') * k };
    },
    onTick(m) {
      const u = m.owner as Unit;
      if (Number.isFinite(m.data.lx)) {
        const step = Math.hypot(u.x - m.data.lx, u.y - m.data.ly);
        if (step < 300) m.data.moved += step;
      }
      m.data.lx = u.x; m.data.ly = u.y;
      if (m.data.moved >= val(a, 'movement_per_vision')) {
        m.data.moved = 0;
        u.w.addVision(u.team, u.x, u.y, val(a, 'vision_radius'), val(a, 'vision_duration'), false);
      }
    },
    onInterval(m) { (m.owner as Unit).refreshStats(); },
  }),
});

defineHero('keeper_of_the_light', [
  'keeper_of_the_light_illuminate', 'keeper_of_the_light_blinding_light', 'keeper_of_the_light_chakra_magic',
  'keeper_of_the_light_radiant_bind', 'keeper_of_the_light_will_o_wisp', 'keeper_of_the_light_spirit_form',
  'keeper_of_the_light_illuminate_end', 'keeper_of_the_light_bright_speed',
], {
  build: ['null_talisman', 'arcane_boots', 'force_staff', 'glimmer_cape', 'aether_lens', 'ultimate_scepter', 'sheepstick', 'octarine_core'],
});
