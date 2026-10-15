import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, hasTalent, val } from '../sim/abilities';
import { damage, kill } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, dash, stun } from './util';

const METEOR_DELAY = 0.57;

/** Lluvia de estrellas en un punto: golpea a todos y repite sobre el más cercano. */
function starstorm(u: Unit, a: AbilityInst, x: number, y: number, r: number, pct = 1, mainTarget?: Unit, mainPct = 1) {
  u.w.emit({ n: 'starfall', x, y, r, t: u.team });
  const targets = u.w.enemiesIn(u.team, x, y, r).filter((e) => e.kind !== 'ward');
  u.w.after(METEOR_DELAY, () => {
    for (const e of targets) if (e.alive) damage(u, e, dmg(a, 'damage') * pct * (e === mainTarget ? mainPct : 1), 'magical', a);
    const near = targets.filter((e) => e.alive && Math.hypot(e.x - x, e.y - y) <= val(a, 'starfall_secondary_radius'))
      .sort((p, q) => Math.hypot(p.x - x, p.y - y) - Math.hypot(q.x - x, q.y - y))
      .slice(0, Math.max(1, val(a, 'secondary_targets')));
    u.w.after(METEOR_DELAY, () => {
      for (const e of near) if (e.alive) damage(u, e, dmg(a, 'damage') * pct * val(a, 'secondary_starfall_damage_percent') / 100, 'magical', a);
    });
  });
}

defineAbility({
  key: 'mirana_starfall', target: 'none', ai: { role: 'aoe', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    starstorm(u, a, u.x, u.y, val(a, 'starfall_radius'));
  },
});

defineAbility({
  key: 'mirana_arrow', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const base = Math.atan2(dy, dx);
    const dirs = [base];
    const extra = val(a, 'extra_arrows');
    const step = val(a, 'extra_arrows_angle') * Math.PI / 180;
    for (let i = 1; i <= extra; i++) dirs.push(base + step * Math.ceil(i / 2) * (i % 2 ? 1 : -1));
    dirs.forEach((ang, idx) => {
      const sx = u.x, sy = u.y;
      u.w.addProjectile({
        kind: 'linear', fx: 'arrow', source: u, x: u.x, y: u.y, dx: Math.cos(ang), dy: Math.sin(ang),
        speed: val(a, 'arrow_speed'), left: val(a, 'arrow_range') + u.s.castRange, width: val(a, 'arrow_width'),
        onThink(p) { if (u.w.tickN % 6 === 0) u.w.addVision(u.team, p.x, p.y, val(a, 'arrow_vision'), 0.3); },
        onHit(_p, e) {
          const v = e as Unit;
          if (v.team === u.team || v.kind === 'ward' || v.kind === 'fountain') return false;
          if (v.has(ST.magicImmune) && !a.def.bkbPierce) return false;
          // Mata al instante a los creeps no ancestrales.
          if (v.kind === 'creep') { kill(v, u); return true; }
          const frac = Math.min(1, Math.hypot(v.x - sx, v.y - sy) / val(a, 'arrow_max_stunrange'));
          damage(u, v, dmg(a, 'abilitydamage') + val(a, 'arrow_bonus_damage') * frac, 'magical', a);
          stun(u, v, val(a, 'arrow_min_stun') + (val(a, 'arrow_max_stun') - val(a, 'arrow_min_stun')) * frac * a.upg.dur, a);
          u.w.addVision(u.team, v.x, v.y, val(a, 'arrow_vision'), 3.11);
          // Scepter: lluvia de estrellas sobre el impacto (el impactado recibe menos).
          const sf = u.abilities.find((x) => x.key === 'mirana_starfall');
          if (idx === 0 && hasScepter(u) && sf && sf.level > 0) {
            starstorm(u, sf, v.x, v.y, val(a, 'scepter_radius'), 1, v, val(a, 'scepter_starstorm_target_pct') / 100);
          }
          return true;
        },
      });
    });
  },
});

defineAbility({
  key: 'mirana_leap', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  charges: (a) => [val(a, 'abilitycharges') + val(a, 'additional_charges'), val(a, 'abilitychargerestoretime')],
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = val(a, 'leap_distance') + u.s.castRange;
    const tx = u.x + Math.cos(u.facing) * d, ty = u.y + Math.sin(u.facing) * d;
    dash(u, tx, ty, val(a, 'leap_speed'), a, {
      name: 'leap', states: ST.flying,
      onArrive() {
        u.addMod({
          name: 'leap_buff', duration: val(a, 'leap_bonus_duration'), fx: 'leap',
          props: { msPct: val(a, 'leap_speedbonus') / 100, attackSpeed: val(a, 'leap_speedbonus_as') },
        }, u, a);
        // Shard: cargas temporales de Celestial Quiver mientras dura el bonus.
        const q = u.findMod('celestial_quiver');
        if (hasShard(u) && q) {
          q.data.temp = val(u.abilities.find((x) => x.key === 'mirana_celestial_quiver')!, 'quiver_restore');
          q.data.tempUntil = u.w.time + val(a, 'leap_bonus_duration');
        }
      },
    });
  },
});

const quiverShots = new WeakSet<object>();

// Innata: cargas que añaden daño mágico al siguiente ataque (una carga más cada 7 niveles).
defineAbility({
  key: 'mirana_celestial_quiver', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'celestial_quiver', stacks: a.data.charges ?? val(a, 'abilitycharges'), interval: val(a, 'abilitychargerestoretime'),
    onInterval(m) {
      const u = m.owner as Unit;
      const max = val(a, 'abilitycharges') + Math.floor(u.level / 7);
      if (m.stacks < max) m.stacks++;
      a.data.charges = m.stacks;
    },
    onTick(m) { if (m.data.temp && (m.owner as Unit).w.time > m.data.tempUntil) m.data.temp = 0; },
    onAttackStart(m, ev) {
      if (ev.fake) return;
      if (m.data.temp > 0) { m.data.temp--; quiverShots.add(ev); return; }
      if (m.stacks <= 0) return;
      m.stacks--; a.data.charges = m.stacks;
      quiverShots.add(ev);
    },
    onAttackLanded(_m, ev) {
      if (!quiverShots.has(ev)) return;
      damage(ev.attacker as Unit, ev.target as Unit, val(a, 'bonus_damage'), 'magical', a);
    },
  }),
});

defineAbility({
  key: 'mirana_invis', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const fade = val(a, 'fade_delay');
    for (const al of u.w.list) {
      if (al.team !== u.team || !al.alive || !al.isHeroLike) continue;
      al.addMod({
        name: 'moonlight_shadow', duration: dur(a, 'duration'), fx: 'moonlight',
        data: { brokeAt: u.w.time },
        props: {
          msPct: val(a, 'bonus_movement_speed') / 100,
          evasion: hasTalent(u, 'special_bonus_unique_mirana_5') ? val(a, 'evasion') / 100 : 0,
          outgoingPct: al === u ? val(a, 'bonus_outgoing_damage_pct') / 100 : 0,
        },
        // Se vuelve invisible tras el retardo; si ataca o lanza, vuelve a desvanecerse.
        onTick(m) {
          const h = m.owner as Unit;
          if (h.findMod('moonlight_invis')) return;
          if (h.w.time - m.data.brokeAt < fade) return;
          h.addMod({
            name: 'moonlight_invis', duration: m.remaining, fx: 'invis', states: ST.invisible,
            data: { breaksOnAttack: true },
            onDestroy() { m.data.brokeAt = h.w.time; },
          }, u, a);
        },
        onDestroy(m) { (m.owner as Unit).removeModsByName('moonlight_invis'); },
      }, u, a);
    }
  },
});

defineHero('mirana', ['mirana_starfall', 'mirana_arrow', 'mirana_leap', 'mirana_celestial_quiver', 'mirana_invis'], {
  build: ['wraith_band', 'power_treads', 'maelstrom', 'dragon_lance', 'black_king_bar', 'butterfly', 'ultimate_scepter'],
});
