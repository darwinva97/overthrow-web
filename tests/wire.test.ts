// El formato compacto de red debe reconstruir exactamente el snapshot original.
import { describe, expect, it } from 'vitest';
import '../shared/heroes';
import '../shared/items';
import { addHero, createGame } from '../shared/game/setup';
import { botThink } from '../shared/overthrow/bot';
import { WireDecoder, WireEncoder } from '../shared/net/wire';
import { board, buildSnapshot } from '../server/snapshot';

describe('formato de red compacto', () => {
  it('ida y vuelta sin pérdidas durante una partida con bots', () => {
    const g = createGame('necropolis', 3);
    const heroes = ['lina', 'pudge', 'phantom_lancer', 'invoker', 'lone_druid', 'sniper', 'axe', 'meepo'];
    const units = heroes.map((h, t) => { const u = addHero(g, h, t, 'p' + t); u.isBot = true; u.addXp(8000); return u; });
    const enc = new WireEncoder(), dec = new WireDecoder();
    let rawBytes = 0, wireBytes = 0, lastMe: unknown = null;
    for (let i = 0; i < 30 * 90; i++) {
      for (const u of units) botThink(g.world, u, g.rules);
      g.world.tick();
      if (i % 2) continue;
      const fx = g.world.fx; g.world.fx = [];
      const s = buildSnapshot(g.world, g.rules, 0, units[0], fx, board(g.world));
      const w = enc.encode(s);
      rawBytes += JSON.stringify(s).length;
      wireBytes += JSON.stringify(w).length;
      const back = dec.decode(JSON.parse(JSON.stringify(w)));
      const plain = JSON.parse(JSON.stringify(s));
      expect(back.u).toEqual(plain.u);
      expect(JSON.parse(JSON.stringify(back.p))).toEqual(plain.p);
      if (w.me !== undefined) lastMe = plain.me;
      expect(JSON.parse(JSON.stringify(back.me))).toEqual(lastMe);
    }
    console.log(`bytes por snapshot: ${(rawBytes / 1350).toFixed(0)} → ${(wireBytes / 1350).toFixed(0)}`);
    expect(wireBytes).toBeLessThan(rawBytes * 0.6);
  }, 60000);
});
