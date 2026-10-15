import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, manaCostOf, val } from '../sim/abilities';
import { creditHero, damage, heal } from '../sim/combat';
import { TREE } from '../sim/nav';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { expire, gate, helper, isUnitLike, nearTree, refund } from './lib/a8';
import { castDir, debuff, slow } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

defineAbility({
  key: 'treant_natures_grasp', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = Math.min(Math.hypot(t.x - u.x, t.y - u.y), val(a, 'abilitycastrange') + u.s.castRange);
    const step = val(a, 'vine_spawn_interval');
    const n = Math.max(1, Math.ceil(len / step));
    const D = dur(a, 'vines_duration');
    const vines: { x: number; y: number; until: number }[] = [];
    const sx = u.x, sy = u.y;
    // Las enredaderas brotan una tras otra desde Treant hacia el punto.
    for (let i = 0; i < n; i++) {
      w.after(val(a, 'initial_latch_delay') + i * val(a, 'creation_interval'), () => {
        const v = { x: sx + dx * step * (i + 0.5), y: sy + dy * step * (i + 0.5), until: w.time + D };
        vines.push(v);
        w.addZone({ fx: 'natures_grasp', x: v.x, y: v.y, r: val(a, 'latch_range'), team: u.team, interval: 99, duration: D, onInterval() {} });
        w.addVision(u.team, v.x, v.y, val(a, 'latch_vision'), D);
      });
    }
    const tick = 0.25;
    w.addZone({
      fx: '', x: sx, y: sy, r: 0, team: u.team, interval: tick, duration: D + n * val(a, 'creation_interval') + 0.5,
      onInterval() {
        const live = vines.filter((v) => v.until > w.time);
        if (!live.length) return;
        const seen = new Set<number>();
        for (const v of live) {
          for (const e of w.enemiesIn(u.team, v.x, v.y, val(a, 'latch_range'))) {
            if (seen.has(e.id) || e.kind === 'ward') continue;
            seen.add(e.id);
            slow(u, e, a, 'natures_grasp_slow', tick + 0.15, val(a, 'movement_slow') / 100);
            const k = e.isHeroLike ? 1 : 1 - val(a, 'creep_penalty') / 100;
            damage(u, e, dmg(a, 'damage_per_second') * tick * k, 'magical', a, { noProc: true });
          }
        }
      },
    });
  },
});

defineAbility({
  key: 'treant_leech_seed', target: 'toggle', ai: { role: 'nuke' },
  passive: (a) => ({
    name: 'leech_seed_autocast',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (!a.toggled || a.cd > 0 || u.kind === 'illusion' || t.team === u.team || !isUnitLike(t)) return;
      if (u.mana < manaCostOf(a) || u.has(ST.silenced)) return;
      u.mana -= manaCostOf(a);
      a.cd = cooldownOf(a);
      (ev as any).leech = true;
    },
    onAttackLanded(_m, ev) {
      if (!(ev as any).leech) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      const D = dur(a, 'duration');
      if (!debuff(u, t, a, { name: 'leech_seed', duration: D, states: ST.rooted | ST.disarmed, fx: 'leech_seed' })) return;
      damage(u, t, dmg(a, 'leech_damage'), 'magical', a);
      const amount = val(a, 'flat_heal') + ev.damage * val(a, 'leech_heal') / 100;
      const pulses = val(a, 'healing_pulse_count');
      for (let i = 0; i < pulses; i++) {
        u.w.after((i + 1) * D / pulses, () => {
          const allies = u.w.alliesIn(u.team, t.x, t.y, val(a, 'radius')).filter(isUnitLike)
            .sort((p, q) => (+q.isHeroLike - +p.isHeroLike) || Math.hypot(p.x - t.x, p.y - t.y) - Math.hypot(q.x - t.x, q.y - t.y))
            .slice(0, val(a, 'max_heal_units'));
          for (const al of allies) heal(al, amount, u);
          u.w.emit({ n: 'leech_pulse', x: t.x, y: t.y, r: val(a, 'radius'), t: u.team });
        });
      }
    },
  }),
});

function livingArmor(u: Unit, t: Unit, a: AbilityInst) {
  const block0 = val(a, 'damage_block_base');
  t.addMod({
    name: 'living_armor', duration: dur(a, 'duration'), fx: 'living_armor', interval: 0.25, data: { block: block0 },
    onInterval(m) { heal(m.owner as Unit, val(a, 'heal_per_second') * 0.25, u, true); },
    // Bloquea daño de fuentes controladas por jugadores y pierde fuerza con cada bloqueo.
    onIncomingDamage(m, ev) {
      const o = m.owner as Unit;
      if (ev.hpRemoval || ev.amount <= 0 || !ev.source || ev.source.team === o.team || !creditHero(ev.source as Unit)) return;
      ev.amount = Math.max(0, ev.amount - m.data.block);
      m.data.block -= val(a, 'damage_block_loss');
      if (m.data.block < val(a, 'damage_block_threshold')) o.removeMod(m);
    },
  }, u, a);
}

defineAbility({
  key: 'treant_living_armor', target: 'unitOrPoint', team: 'any', allowSelf: true, reflectable: false, ai: { role: 'heal' },
  // Alcance global.
  castRange: () => 99999,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    let tgt = t.unit && t.unit.team === u.team ? (t.unit as Unit) : null;
    if (!tgt) {
      const heroes = w.list.filter((h) => h.team === u.team && h.isHeroLike && h.alive && w.targetable(h));
      // Sobre un punto: el héroe aliado más cercano. Sobre un enemigo (bots): el aliado más herido.
      tgt = t.unit
        ? heroes.sort((p, q) => p.hp / p.s.maxHp - q.hp / q.s.maxHp)[0]
        : heroes.sort((p, q) => Math.hypot(p.x - t.x, p.y - t.y) - Math.hypot(q.x - t.x, q.y - t.y))[0];
    }
    if (!tgt) { refund(a); return; }
    const r = val(a, 'aoe_radius');
    const list = r > 0 ? w.alliesIn(u.team, tgt.x, tgt.y, r, { heroes: true }) : [tgt];
    if (!list.includes(tgt)) list.push(tgt);
    for (const al of list) livingArmor(u, al, a);
  },
});

/** Ojos vivos de Treant. */
function eyesOf(u: Unit): Unit[] {
  const a = ability(u, 'treant_eyes_in_the_forest');
  if (!a) return [];
  a.data.eyes = ((a.data.eyes ?? []) as Unit[]).filter((e) => e.alive);
  return a.data.eyes;
}

defineAbility({
  key: 'treant_eyes_in_the_forest', target: 'point', ai: { role: 'summon' },
  charges: (a) => [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const tree = w.nearestTree(t.x, t.y, 250);
    if (!tree) { w.error(u, 'Tiene que ser un árbol'); refund(a); return; }
    const eye = helper(u, 'treant_eyes', tree.x, tree.y, val(a, 'duration'), ST.invisible | ST.noCollision | ST.flying);
    eye.x = tree.x; eye.y = tree.y;
    eye.addMod({
      name: 'eyes_in_the_forest', persistent: true, fx: 'treant_eyes', data: { hits: 0 },
      props: { vision: val(a, 'vision_aoe') - eye.base.dayVision },
      onTick() { if (w.grid.cellAt(tree.cx, tree.cy) !== TREE) expire(eye); },
      onIncomingDamage(m, ev) {
        ev.amount = 0;
        if (ev.isAttack && ++m.data.hits >= val(a, 'hits_to_kill')) expire(eye);
      },
    });
    const eyes = eyesOf(u);
    eyes.push(eye);
    const max = val(a, 'max_eyes');
    while (max > 0 && eyes.length > max) expire(eyes.shift()!);
  },
});

defineAbility({
  key: 'treant_natures_guise', target: 'none', innate: true, ai: { role: 'buff', selfRadius: 1200 },
  passive: (a) => ({
    name: 'natures_guise', interval: 0.25, data: { near: false },
    props: (m) => (m.data.near ? { msPct: val(a, 'movement_bonus') / 100 } : {}),
    onInterval(m) {
      const u = m.owner as Unit;
      const near = nearTree(u, val(a, 'radius'));
      if (near !== m.data.near) { m.data.near = near; u.refreshStats(); }
      // Solo se activa junto a un árbol y sin haber recibido daño hace poco.
      gate(a, near && u.w.time - u.lastDamageAt >= val(a, 'cooldown_time'));
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (!nearTree(u, val(a, 'radius'))) return;
    u.addMod({
      name: 'natures_guise_invis', fx: 'invis', states: ST.invisible, data: { breaksOnAttack: true, away: 0 },
      onTick(m, dt) {
        m.data.away = nearTree(u, val(a, 'radius')) ? 0 : m.data.away + dt;
        if (m.data.away > val(a, 'grace_time')) m.data.breakNow = true;
      },
    }, u, a);
  },
});

defineAbility({
  key: 'treant_overgrowth', target: 'none', ult: true, ai: { role: 'disable', selfRadius: 600 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const R = val(a, 'radius');
    const D = dur(a, 'duration');
    const hit = new Set<Unit>(w.enemiesIn(u.team, u.x, u.y, R));
    w.emit({ n: 'overgrowth', x: u.x, y: u.y, r: R, t: u.team });
    // Shard: también brota alrededor de los ojos del bosque.
    for (const eye of eyesOf(u)) {
      w.emit({ n: 'overgrowth', x: eye.x, y: eye.y, r: R, t: u.team });
      for (const e of w.enemiesIn(u.team, eye.x, eye.y, R)) hit.add(e);
    }
    for (const e of hit) {
      if (e.kind === 'ward') continue;
      const m = debuff(u, e, a, {
        name: 'overgrowth', duration: D, fx: 'overgrowth', states: ST.rooted | ST.disarmed | ST.revealed, interval: 0.5,
        onInterval(mm) { damage(u, mm.owner as Unit, dmg(a, 'damage') * 0.5, 'magical', a, { noProc: true }); },
      });
      if (m && e.cast?.phase === 2) w.interruptCast(e, true);
    }
    if (hasScepter(u)) {
      u.addMod({
        name: 'overgrowth_bloom', duration: val(a, 'bloom_duration'), fx: 'bloom', states: ST.noCollision,
        props: () => ({ str: u.baseAttr('str') * val(a, 'strength_bonus') / 100, msFixed: val(a, 'movement_speed') }),
        onAttackLanded(_m, ev) {
          if (ev.fake) return;
          const t = ev.target as Unit;
          const amount = ev.damage * ev.critMult * val(a, 'splash_pct') / 100;
          for (const e of w.enemiesIn(u.team, t.x, t.y, val(a, 'splash_radius'))) {
            if (e !== t && e.kind !== 'ward') damage(u, e, amount, 'physical', a, { noProc: true });
          }
        },
      }, u, a);
    }
  },
});

defineHero('treant', ['treant_natures_grasp', 'treant_leech_seed', 'treant_living_armor', 'treant_eyes_in_the_forest',
  'treant_natures_guise', 'treant_overgrowth'], {
  build: ['phase_boots', 'magic_wand', 'blink', 'pipe', 'ultimate_scepter', 'crimson_guard', 'shivas_guard'],
});
