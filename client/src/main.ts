import './style.css';
// Los registros de héroes e items también hacen falta en el cliente (tienda, kits).
import '../../shared/heroes';
import '../../shared/items';
import '../../shared/items/neutral';
import type { ServerMsg } from '../../shared/net/protocol';
import { Game } from './game/game';
import { Net, clearSession, loadSession } from './net';
import { renderHome, renderLobby } from './ui/menus';

const app = document.querySelector<HTMLDivElement>('#app')!;
const net = new Net();
let myId = '';
let game: Game | null = null;
let screen: 'home' | 'lobby' | 'game' = 'home';

function home(error = '') {
  screen = 'home';
  game?.dispose();
  game = null;
  history.replaceState(null, '', location.pathname);
  renderHome(app, {
    quick: (name, map, hero) => net.send({ t: 'create', name, map, quick: true, hero: hero ?? undefined }),
    create: (name, map) => net.send({ t: 'create', name, map }),
    join: (name, code) => net.send({ t: 'join', name, code }),
  }, error);
}

function leaveToHome() {
  net.send({ t: 'leave' });
  clearSession();
  home();
}

net.on((m: ServerMsg) => {
  switch (m.t) {
    case 'welcome':
      myId = m.id;
      history.replaceState(null, '', `?sala=${m.code}`);
      break;
    case 'lobby':
      if (m.lobby.state === 'lobby' && screen !== 'game') {
        screen = 'lobby';
        renderLobby(app, m.lobby, myId, {
          pick: (hero) => net.send({ t: 'pick', hero }),
          team: (team) => net.send({ t: 'team', team }),
          map: (map) => net.send({ t: 'map', map }),
          bots: (fill) => net.send({ t: 'bots', fill }),
          start: () => net.send({ t: 'start' }),
          leave: leaveToHome,
        });
      }
      break;
    case 'start':
      if (game) break;
      screen = 'game';
      app.innerHTML = '';
      game = new Game(net, m, () => { clearSession(); home(); });
      app.append(game.root);
      break;
    case 'err':
      if (screen === 'home') home(m.msg);
      else if (screen === 'lobby') alert(m.msg);
      if (m.msg === 'No se pudo volver a la partida') { clearSession(); if (screen !== 'game') home(); }
      break;
  }
});

net.connect();
const invite = new URLSearchParams(location.search).get('sala');
if (invite && !loadSession()) {
  // Enlace de invitación: entra directamente con el nombre guardado.
  home();
  const name = localStorage.getItem('overthrow.name') || 'Jugador';
  net.send({ t: 'join', name, code: invite.toUpperCase() });
} else {
  home();
}
