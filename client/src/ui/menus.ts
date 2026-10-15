// Pantalla de inicio y sala de espera.
import { HEROES, heroPortrait } from '../../../shared/data';
import { HERO_KITS } from '../../../shared/sim/abilities';
import { MAPS } from '../../../shared/maps';
import type { LobbyState } from '../../../shared/net/protocol';
import { TEAM_COLORS, TEAM_NAMES } from '../../../shared/overthrow/rules';
import { ATTR_COLOR } from '../render/fxstyle';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const NAME_KEY = 'overthrow.name';

export const playable = () => Object.keys(HERO_KITS).sort((a, b) => HEROES[a].name.localeCompare(HEROES[b].name));

function modeShape(key: string) {
  const d = MAPS[key];
  return `<span class="shape">${Array.from({ length: d.teams }, (_, t) =>
    `<span>${Array.from({ length: Math.min(d.teamSize, 8) }, () => `<i style="background:${TEAM_COLORS[t]}"></i>`).join('')}</span>`).join('')}</span>`;
}

export interface HomeActions {
  quick(name: string, map: string, hero: string | null): void;
  create(name: string, map: string): void;
  join(name: string, code: string): void;
}

export function renderHome(root: HTMLElement, act: HomeActions, error = '') {
  let map = localStorage.getItem('overthrow.map') ?? 'necropolis';
  const name = localStorage.getItem(NAME_KEY) ?? '';
  root.innerHTML = `
  <div class="menu"><div class="home">
    <section>
      <h1 class="title">Overthrow<small>El modo Arcade de Dota 2, en el navegador</small></h1>
      <p class="lede">Todos contra todos alrededor del Midas Throne. Gana el primer equipo que llega al límite de kills o el que más lleve cuando se acabe el tiempo. Cada jugador elige si ve la partida en 2D o en 3D, y se puede cambiar en cualquier momento con F2.</p>
      <ul class="rules">
        <li><i class="gem"></i><span><b>Midas Throne.</b> Quedarte junto al trono del centro te da oro y experiencia cada segundo.</span></li>
        <li><i class="gem" style="background:#7fe0ff"></i><span><b>Orbes del Kobold King.</b> Captúralo quedándote encima sin enemigos cerca y todo tu equipo elige una mejora.</span></li>
        <li><i class="gem" style="background:#c27bff"></i><span><b>Remontadas.</b> Los equipos que van detrás reciben orbes antes, y cada 8 kills llega uno raro.</span></li>
      </ul>
    </section>
    <section class="panel">
      <h2>Jugar</h2>
      <div class="field"><label for="nm">Tu nombre</label><input id="nm" class="input" maxlength="20" autocomplete="nickname" value="${esc(name)}" placeholder="Jugador"></div>
      <div class="field"><label>Modo</label><div class="modes">${Object.values(MAPS).map((d) => `
        <button class="mode" data-map="${d.key}" aria-pressed="${d.key === map}"><span class="name">${d.name}</span>${modeShape(d.key)}<span class="sub">${d.teams} equipos de ${d.teamSize} · ${d.killGoal} kills</span></button>`).join('')}
      </div></div>
      <div class="stack">
        <button class="btn primary" id="quick">Jugar ya contra bots</button>
        <button class="btn" id="create">Crear sala para jugar con amigos</button>
      </div>
      <div class="sep"></div>
      <div class="field"><label for="code">¿Te han pasado un código?</label>
        <div class="row"><input id="code" class="input grow" maxlength="5" placeholder="ABCDE" autocomplete="off" style="text-transform:uppercase"><button class="btn" id="join">Entrar</button></div>
      </div>
      <div class="err" role="alert">${esc(error)}</div>
    </section>
  </div></div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const nm = () => { const v = $<HTMLInputElement>('#nm').value.trim() || 'Jugador'; localStorage.setItem(NAME_KEY, v); return v; };
  root.querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => b.onclick = () => {
    map = b.dataset.map!;
    localStorage.setItem('overthrow.map', map);
    root.querySelectorAll('.mode').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  });
  $('#quick').onclick = () => act.quick(nm(), map, localStorage.getItem('overthrow.hero'));
  $('#create').onclick = () => act.create(nm(), map);
  const join = () => { const c = $<HTMLInputElement>('#code').value.trim().toUpperCase(); if (c.length === 5) act.join(nm(), c); };
  $('#join').onclick = join;
  $<HTMLInputElement>('#code').onkeydown = (e) => { if (e.key === 'Enter') join(); };
}

export interface LobbyActions {
  pick(hero: string): void;
  team(t: number): void;
  map(m: string): void;
  bots(fill: boolean): void;
  start(): void;
  leave(): void;
}

const heroFilter = { attr: '', q: '' };

export function renderLobby(root: HTMLElement, l: LobbyState, me: string, act: LobbyActions) {
  const mine = l.players.find((p) => p.id === me);
  const host = l.host === me;
  const taken = new Map(l.players.filter((p) => p.hero && p.id !== me).map((p) => [p.hero!, p.name]));
  const heroes = playable();
  const teams = Array.from({ length: l.teams }, (_, t) => {
    const ps = l.players.filter((p) => p.team === t);
    const slots = Array.from({ length: l.teamSize }, (_, i) => ps[i]);
    return `<div class="team"><div class="th"><i style="background:${TEAM_COLORS[t]}"></i>${TEAM_NAMES[t]}
      ${mine?.team !== t && ps.length < l.teamSize ? `<button class="btn" data-team="${t}">Unirme</button>` : ''}</div>
      ${slots.map((p) => p ? `<div class="slot">${p.hero ? `<img src="${heroPortrait(p.hero)}" alt="">` : '<img alt="">'}<span>${esc(p.name)}</span>
        ${p.id === me ? '<span class="you">tú</span>' : ''}${p.bot ? '<span class="hint">bot</span>' : ''}${!p.online ? '<span class="hint">desconectado</span>' : ''}</div>`
        : `<div class="slot"><img alt=""><span class="empty">${l.fillBots ? 'un bot ocupará este hueco' : 'libre'}</span></div>`).join('')}
    </div>`;
  }).join('');
  root.innerHTML = `
  <div class="menu"><div class="lobby">
    <header><h1>Sala</h1><span class="code" title="Pasa este código a tus amigos">${l.code}</span>
      <span class="hint">Comparte el código o el enlace: ${esc(location.origin)}/?sala=${l.code}</span>
      <span class="grow"></span><button class="btn" id="leave">Salir</button></header>
    <section>
      <div class="row" style="margin:0 0 12px;flex-wrap:wrap">
        <h2 style="font-family:var(--display);margin:0 12px 0 0">Elige héroe</h2>
        <div class="attr-tabs">${[['', 'Todos'], ['str', 'Fuerza'], ['agi', 'Agilidad'], ['int', 'Inteligencia'], ['all', 'Universal']].map(([k, l]) =>
          `<button class="btn" data-attr="${k}" aria-pressed="${heroFilter.attr === k}">${l}</button>`).join('')}</div>
        <input id="hsearch" class="input" style="max-width:200px" placeholder="Buscar héroe" value="${esc(heroFilter.q)}">
      </div>
      <div class="heroes">${heroes.filter((k) => (!heroFilter.attr || HEROES[k].attr === heroFilter.attr) &&
        (!heroFilter.q || HEROES[k].name.toLowerCase().includes(heroFilter.q.toLowerCase()))).map((k) => {
        const h = HEROES[k];
        return `<button class="hero-card" data-hero="${k}" aria-pressed="${mine?.hero === k}"><img src="${heroPortrait(k)}" alt="" loading="lazy">
          <span class="hn">${esc(h.name)}<i class="attr" style="background:${ATTR_COLOR[h.attr]}"></i></span>
          ${taken.has(k) ? `<span class="taken">${esc(taken.get(k)!)}</span>` : ''}</button>`;
      }).join('')}</div>
      <p class="hint" style="margin-top:12px">${heroes.length} de los 127 héroes de Dota disponibles.</p>
    </section>
    <aside class="panel">
      <div class="field"><label for="map">Modo</label>
        <select id="map" class="input" ${host ? '' : 'disabled'}>${Object.values(MAPS).map((d) => `<option value="${d.key}" ${d.key === l.map ? 'selected' : ''}>${d.name} (${d.teams}×${d.teamSize})</option>`).join('')}</select></div>
      <label class="row hint" style="margin-bottom:14px"><input type="checkbox" id="bots" ${l.fillBots ? 'checked' : ''} ${host ? '' : 'disabled'}> Rellenar los huecos con bots</label>
      <div class="teams">${teams}</div>
      <div class="sep"></div>
      ${host ? '<button class="btn primary" id="start" style="width:100%">Empezar partida</button>' : '<p class="hint">Esperando a que el anfitrión empiece la partida.</p>'}
    </aside>
  </div></div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-hero]').forEach((b) => b.onclick = () => { localStorage.setItem('overthrow.hero', b.dataset.hero!); act.pick(b.dataset.hero!); });
  root.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((b) => b.onclick = () => act.team(+b.dataset.team!));
  root.querySelectorAll<HTMLButtonElement>('[data-attr]').forEach((b) => b.onclick = () => { heroFilter.attr = b.dataset.attr!; renderLobby(root, l, me, act); });
  const hs = root.querySelector('#hsearch') as HTMLInputElement;
  hs.oninput = () => {
    heroFilter.q = hs.value;
    const pos = hs.selectionStart;
    renderLobby(root, l, me, act);
    const n = root.querySelector('#hsearch') as HTMLInputElement;
    n.focus(); n.setSelectionRange(pos, pos);
  };
  (root.querySelector('#leave') as HTMLButtonElement).onclick = act.leave;
  const map = root.querySelector('#map') as HTMLSelectElement;
  map.onchange = () => act.map(map.value);
  const bots = root.querySelector('#bots') as HTMLInputElement;
  bots.onchange = () => act.bots(bots.checked);
  const st = root.querySelector('#start') as HTMLButtonElement | null;
  if (st) st.onclick = act.start;
}
