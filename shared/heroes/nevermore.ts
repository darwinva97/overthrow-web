import { defineAbility, defineHero, dmg, hasShard, hasTalent, val } from '../sim/abilities';
import { damage, heal, landAttack, makeAttack } from '../sim/combat';
import type { AbilityImpl, AbilityInst } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff } from './util';
import { fear } from './lib/a5';

/** Almas actuales (se guardan en la innata para sobrevivir a los refrescos de pasivas). */
function soulsOf(u: Unit): number {
  const nm = u.abilities.find((x) => x.key === 'nevermore_necromastery');
  return nm ? (nm.data.souls ?? 0) + (nm.data.temp ?? 0) : 0;
}
function maxSouls(u: Unit) {
  const nm = u.abilities.find((x) => x.key === 'nevermore_necromastery');
  return nm ? val(nm, 'necromastery_max_souls') : 20;
}
function addSouls(u: Unit, n: number) {
  const nm = u.abilities.find((x) => x.key === 'nevermore_necromastery');
  if (!nm) return;
  nm.data.souls = Math.max(0, Math.min(maxSouls(u), (nm.data.souls ?? 0) + n));
  u.refreshStats();
}

function raze(slot: 1 | 2 | 3): AbilityImpl {
  return {
    key: `nevermore_shadowraze${slot}`, target: 'none',
    ai: { role: 'nuke', selfRadius: [400, 650, 900][slot - 1] },
    // Feast of Souls con talento acelera el lanzamiento.
    castPoint(a) {
      const u = a.owner as Unit;
      const base = val(a, 'abilitycastpoint');
      const fr = u.findMod('frenzy');
      return fr && hasTalent(u, 'special_bonus_unique_nevermore_frenzy_castspeed') ? base / (1 + val(fr.ability as AbilityInst, 'cast_speed_pct_tooltip') / 100) : base;
    },
    onSpellStart(a) {
      const u = a.owner as Unit;
      const d = val(a, 'shadowraze_range');
      const x = u.x + Math.cos(u.facing) * d, y = u.y + Math.sin(u.facing) * d;
      const r = val(a, 'shadowraze_radius');
      u.w.emit({ n: 'shadowraze', x, y, r, t: u.team });
      const base = dmg(a, 'shadowraze_damage') + soulsOf(u) * val(a, 'damage_per_soul');
      let heroes = 0;
      for (const e of u.w.enemiesIn(u.team, x, y, r)) {
        const st = e.findMod('shadowraze_stack', u);
        const stacks = st?.stacks ?? 0;
        damage(u, e, base + stacks * val(a, 'stack_bonus_damage'), 'magical', a);
        if (val(a, 'procs_attack') > 0 && e.alive) { const ev = makeAttack(u, e, true); ev.trueStrike = true; landAttack(ev); }
        if (!e.alive) continue;
        if (e.kind === 'hero') heroes++;
        const slowPer = val(a, 'movement_speed_debuff') / 100;
        const m = debuff(u, e, a, {
          name: 'shadowraze_stack', duration: val(a, 'duration'), stacks: stacks + 1, fx: 'shadowraze',
          props: (mm) => ({ msSlow: slowPer * mm.stacks }),
        });
        if (m) { m.stacks = stacks + 1; m.remaining = m.duration = val(a, 'duration'); e.refreshStats(); }
      }
      // Shard: enfriamiento menor por héroe golpeado.
      if (heroes && hasShard(u)) a.cd = Math.max(0, a.cd - heroes * val(a, 'cooldown_reduction_on_hero_hit'));
    },
  };
}
defineAbility(raze(1));
defineAbility(raze(2));
defineAbility(raze(3));

// Feast of Souls: velocidad y recolecta almas temporales de enemigos cercanos.
defineAbility({
  key: 'nevermore_frenzy', target: 'none', ai: { role: 'buff', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const nm = u.abilities.find((x) => x.key === 'nevermore_necromastery');
    const from = new Map<number, number>();
    let collected = 0;
    u.addMod({
      name: 'frenzy', duration: val(a, 'duration'), fx: 'frenzy', interval: val(a, 'soul_collection_interval'),
      props: { attackSpeed: val(a, 'bonus_attack_speed'), msPct: val(a, 'bonus_move_speed') / 100 },
      onInterval() {
        if (!nm) return;
        const list = u.w.enemiesIn(u.team, u.x, u.y, val(a, 'soul_collection_radius'))
          .filter((e) => !from.has(e.id) && (e.kind === 'hero' || e.kind === 'creep'))
          .slice(0, val(a, 'soul_collection_per_interval'));
        for (const e of list) {
          if (collected >= val(a, 'max_collection_count')) break;
          const n = Math.min(val(a, 'max_collection_count') - collected, e.kind === 'hero' ? val(a, 'soul_collection_per_hero') : val(a, 'soul_collection_per_creep'));
          from.set(e.id, n);
          collected += n;
          nm.data.temp = (nm.data.temp ?? 0) + n;
          u.w.emit({ n: 'soul', x: e.x, y: e.y, x2: u.x, y2: u.y, u: e.id, u2: u.id });
        }
        u.refreshStats();
      },
      onDestroy() {
        if (!nm) return;
        // Pierde las almas de enemigos que siguen vivos; el resto se queda un rato.
        let keep = 0;
        for (const [id, n] of from) { const e = u.w.units.get(id); if (!e || !e.alive) keep += n; }
        nm.data.temp = Math.max(0, (nm.data.temp ?? 0) - collected + keep);
        u.refreshStats();
        u.w.after(val(a, 'linger_duration'), () => {
          nm.data.souls = Math.min(maxSouls(u), (nm.data.souls ?? 0) + Math.min(keep, nm.data.temp ?? 0));
          nm.data.temp = Math.max(0, (nm.data.temp ?? 0) - keep);
          u.refreshStats();
        });
      },
    }, u, a);
  },
});

defineAbility({
  key: 'nevermore_dark_lord', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'presence',
    aura: {
      radius: val(a, 'presence_radius'), team: 'enemy',
      apply: () => ({ name: 'presence_armor', debuff: true, props: { armor: val(a, 'presence_armor_reduction') } }),
    },
  }),
});

/** Requiem: líneas en círculo, una por alma; cada línea golpea, ralentiza y asusta. */
function requiem(u: Unit, a: AbilityInst, frac = 1) {
  const lines = Math.max(1, Math.floor(Math.min(val(a, 'max_soul_release'), soulsOf(u)) * val(a, 'requiem_soul_conversion') * frac));
  const cx = u.x, cy = u.y;
  const R = val(a, 'requiem_radius');
  const hitCount = new Map<number, number>();
  let dealt = 0;
  u.w.emit({ n: 'requiem', x: cx, y: cy, r: R, t: u.team });
  const per = val(a, 'requiem_slow_duration'), maxD = val(a, 'requiem_slow_duration_max');
  const onLine = (e: Unit) => {
    if (e.team === u.team || e.kind === 'ward' || e.kind === 'fountain') return;
    dealt += damage(u, e, dmg(a, 'abilitydamage'), 'magical', a);
    if (!e.alive) return;
    const n = (hitCount.get(e.id) ?? 0) + 1;
    hitCount.set(e.id, n);
    const d = Math.min(maxD, per * n);
    debuff(u, e, a, {
      name: 'requiem_debuff', duration: d, fx: 'slow',
      props: { msSlow: -val(a, 'requiem_reduction_ms') / 100, magicResist: val(a, 'requiem_reduction_mres') / 100 },
    });
    const m = e.findMod('requiem_debuff', u);
    if (m) m.remaining = Math.max(m.remaining, d);
    const f = e.findMod('requiem_fear', u);
    if (f) f.remaining = Math.max(f.remaining, d);
    else fear(u, e, d, a, cx, cy, 'requiem_fear');
  };
  for (let i = 0; i < lines; i++) {
    const ang = (i / lines) * Math.PI * 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    u.w.addProjectile({
      kind: 'linear', fx: 'requiem', source: u, x: cx, y: cy, dx, dy, speed: val(a, 'requiem_line_speed'),
      left: R, width: val(a, 'requiem_line_width_start'), widthEnd: val(a, 'requiem_line_width_end'),
      onHit(_p, e) { onLine(e as Unit); },
      onEnd(p) {
        // Scepter: la línea vuelve hacia Shadow Fiend y le cura lo infligido.
        if (val(a, 'requiem_heal_pct_scepter') <= 0 || !u.alive) return;
        const bx = p.x, by = p.y;
        const back = Math.hypot(u.x - bx, u.y - by) || 1;
        u.w.addProjectile({
          kind: 'linear', fx: 'requiem', source: u, x: bx, y: by, dx: (u.x - bx) / back, dy: (u.y - by) / back,
          speed: val(a, 'requiem_line_speed'), left: back, width: val(a, 'requiem_line_width_end'), widthEnd: val(a, 'requiem_line_width_start'),
          onHit(_q, e) {
            const v = e as Unit;
            if (v.team === u.team) return;
            const got = damage(u, v, dmg(a, 'abilitydamage') * val(a, 'requiem_damage_pct_scepter') / 100, 'magical', a);
            heal(u, got * val(a, 'requiem_heal_pct_scepter') / 100, u, true);
          },
        });
      },
    });
  }
  return dealt;
}

defineAbility({
  key: 'nevermore_requiem', target: 'none', ult: true, ai: { role: 'nuke', selfRadius: 450 },
  // Se lanza solo al morir, aunque esté en enfriamiento.
  passive: (a) => ({
    name: 'requiem_on_death',
    onDeath(m) { const u = m.owner as Unit; if (u.kind === 'hero') requiem(u, a, val(a, 'soul_death_release')); },
  }),
  onSpellStart(a) { requiem(a.owner as Unit, a); },
});

defineAbility({
  key: 'nevermore_necromastery', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'necromastery',
    props: () => ({ damage: ((a.data.souls ?? 0) + (a.data.temp ?? 0)) * val(a, 'necromastery_damage_per_soul') }),
    onKill(m, v) {
      const u = m.owner as Unit;
      if (v.team === u.team || u.kind !== 'hero') return;
      const n = v.kind === 'hero' ? val(a, 'souls_per_hero_kill') : Math.max(val(a, 'souls_per_kill'), val(a, 'shard_souls_per_kill'));
      addSouls(u, n);
    },
    onDeath(m) {
      const u = m.owner as Unit;
      if (u.kind !== 'hero') return;
      // Después de que Requiem use las almas al morir.
      u.w.after(0, () => {
        a.data.souls = Math.floor((a.data.souls ?? 0) * val(a, 'necromastery_soul_release'));
        a.data.temp = 0;
      });
    },
  }),
});

defineHero('nevermore', ['nevermore_shadowraze1', 'nevermore_shadowraze2', 'nevermore_shadowraze3', 'nevermore_frenzy', 'nevermore_dark_lord', 'nevermore_requiem', 'nevermore_necromastery'], {
  build: ['wraith_band', 'power_treads', 'dragon_lance', 'black_king_bar', 'satanic', 'greater_crit', 'butterfly'],
});
