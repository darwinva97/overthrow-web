import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, giveMana, heal } from '../sim/combat';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, illusionsOf } from './util';
import { gate } from './lib/a5';

defineAbility({
  key: 'naga_siren_mirror_image', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const inv = val(a, 'invuln_duration');
    u.purge(true, false);
    u.w.disjoint(u);
    u.order = null; u.atk.phase = 0;
    u.addMod({ name: 'mirror_image_invuln', duration: inv, states: ST.invulnerable | ST.hidden | ST.untargetable, fx: 'mirror_image' }, u, a);
    u.w.after(inv, () => {
      if (!u.alive) return;
      // Las imágenes aparecen alrededor y Naga ocupa un hueco al azar.
      const n = val(a, 'images_count');
      const spots: [number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const ang = (i / (n + 1)) * Math.PI * 2 + u.facing;
        spots.push([u.x + Math.cos(ang) * 108, u.y + Math.sin(ang) * 108]);
      }
      const me = Math.floor(u.w.rng() * spots.length);
      const [mx, my] = spots.splice(me, 1)[0];
      u.w.teleport(u, mx, my);
      for (const [x, y] of spots) {
        u.w.spawnIllusion(u, x, y, val(a, 'illusion_duration'), val(a, 'outgoing_damage') / 100, val(a, 'incoming_damage') / 100);
      }
    });
  },
});

defineAbility({
  key: 'naga_siren_ensnare', target: 'unit', reflectable: true, ai: { role: 'disable' },
  // Scepter: puede atrapar a unidades inmunes a hechizos y aplica Break.
  passive: (a) => ({ name: 'ensnare_pierce', onTick() { a.data.pierce = hasScepter(a.owner as Unit); } }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'ensnare', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'net_speed'), dodgeable: true,
      onHit() {
        if (e.has(ST.magicImmune) && val(a, 'can_target_magic_immune') <= 0) return true;
        if (e.cast) e.w.interruptCast(e, true);
        const spec = {
          name: 'ensnare', duration: dur(a, 'duration'), debuff: true, fx: 'root',
          states: ST.rooted | (val(a, 'does_break') > 0 ? ST.broken : 0),
        };
        e.addMod(spec, u, a);
        return true;
      },
    });
  },
});

defineAbility({
  key: 'naga_siren_rip_tide', target: 'passive',
  passive: (a) => ({
    name: 'rip_tide', stacks: 0,
    onAttackLanded(m, ev) {
      const u = ev.attacker as Unit;
      if (ev.fake) return;
      m.stacks++;
      if (m.stacks < val(a, 'hits')) return;
      m.stacks = 0;
      const r = val(a, 'radius');
      u.w.emit({ n: 'rip_tide', x: u.x, y: u.y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        debuff(u, e, a, { name: 'rip_tide_armor', duration: val(a, 'duration'), props: { armor: val(a, 'armor_reduction') } });
      }
    },
  }),
});

// Canaliza para arrastrar hacia Naga a los enemigos atrapados por Ensnare.
defineAbility({
  key: 'naga_siren_reel_in', target: 'none', levelWith: 1, ai: { role: 'disable', selfRadius: 1500 },
  channel: (a) => val(a, 'abilitychanneltime'),
  passive: gate((a) => {
    const u = a.owner as Unit;
    return u.w.list.some((e) => e.alive && e.team !== u.team && e.findMod('ensnare', u) && Math.hypot(e.x - u.x, e.y - u.y) <= val(a, 'radius'));
  }),
  onSpellStart() { /* el arrastre ocurre en cada tick de canalización */ },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    let any = false;
    for (const e of u.w.list) {
      if (!e.alive || e.team === u.team || !e.findMod('ensnare', u)) continue;
      const d = Math.hypot(u.x - e.x, u.y - e.y);
      if (d > val(a, 'radius')) continue;
      if (e.has(ST.magicImmune) && val(a, 'can_target_magic_immune') <= 0) continue;
      if (d <= val(a, 'min_pull_distance')) continue;
      any = true;
      const step = Math.min(d - val(a, 'min_pull_distance'), val(a, 'pull_strength') * dt);
      e.w.forceMove(e, e.x + (u.x - e.x) / d * step, e.y + (u.y - e.y) / d * step);
    }
    if (!any) u.w.interruptCast(u, false);
  },
});

defineAbility({
  key: 'naga_siren_eelskin', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'eelskin', interval: 0.5,
    props: (m) => ({ evasion: val(a, 'evasion_per_naga') * (1 + (m.data.n ?? 0)) / 100 }),
    onInterval(m) {
      const u = m.owner as Unit;
      const hero = u.kind === 'illusion' ? (u.owner as Unit) : u;
      const nagas = [hero, ...illusionsOf(hero)].filter((x) => x !== u && x.alive && Math.hypot(x.x - u.x, x.y - u.y) <= val(a, 'radius'));
      if (nagas.length !== m.data.n) { m.data.n = nagas.length; u.refreshStats(); }
    },
  }),
});

defineAbility({
  key: 'naga_siren_song_of_the_siren', target: 'none', ult: true, ai: { role: 'disable', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.addMod({
      name: 'song_of_the_siren', duration: val(a, 'duration') * a.upg.dur, fx: 'song',
      interval: 1,
      aura: {
        radius: r, team: 'enemy',
        apply: (_m, t) => (t.has(ST.magicImmune) ? { name: 'song_immune' } : {
          name: 'song_sleep', debuff: true, purgable: false, fx: 'sleep',
          states: ST.stunned | ST.invulnerable,
          onCreated(mm) { const v = mm.owner as Unit; if (v.cast) v.w.interruptCast(v, true); v.atk.phase = 0; },
        }),
      },
      // Cura a los aliados en el radio (con Shard también maná).
      onInterval() {
        for (const al of u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true })) {
          heal(al, al.s.maxHp * val(a, 'heal_pct') / 100, u, true);
          giveMana(al, al.s.maxMana * val(a, 'mana_pct') / 100);
        }
      },
      onDestroy() { for (const e of u.w.list) e.findMod('song_sleep', u) && e.removeMod(e.findMod('song_sleep', u)!); },
    }, u, a);
  },
});

defineAbility({
  key: 'naga_siren_song_of_the_siren_cancel', target: 'none', levelWith: 5, ai: { role: 'summon', selfRadius: 2000 },
  hidden: (a) => !(a.owner as Unit).findMod('song_of_the_siren'),
  passive: gate((a) => !!(a.owner as Unit).findMod('song_of_the_siren')),
  onSpellStart(a) { (a.owner as Unit).removeModsByName('song_of_the_siren'); },
});

defineHero('naga_siren', ['naga_siren_mirror_image', 'naga_siren_ensnare', 'naga_siren_rip_tide', 'naga_siren_reel_in', 'naga_siren_eelskin', 'naga_siren_song_of_the_siren', 'naga_siren_song_of_the_siren_cancel'], {
  build: ['wraith_band', 'power_treads', 'diffusal_blade', 'manta', 'heart', 'skadi', 'butterfly'],
});
