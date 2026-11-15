import './style.css';
import { Game } from './ui/game';
import type { GameSettings } from './ui/game';
import type { UnitSize } from './sim/data';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const game = new Game(canvas);
(window as unknown as { __game: Game }).__game = game; // debug hook for automated checks

const settings: GameSettings = {
  seed: 1 + Math.floor(Math.random() * 9999),
  playerFaction: 'rome',
  size: 'large',
};

function bindChoice(group: string, apply: (v: string) => void) {
  const btns = document.querySelectorAll<HTMLButtonElement>(`[data-group="${group}"]`);
  btns.forEach((b) =>
    b.addEventListener('click', () => {
      btns.forEach((x) => x.classList.toggle('on', x === b));
      apply(b.dataset.value!);
    }),
  );
}

bindChoice('side', (v) => (settings.playerFaction = v as GameSettings['playerFaction']));
bindChoice('size', (v) => (settings.size = v as UnitSize));

const seedEl = document.getElementById('seed')!;
seedEl.textContent = `#${settings.seed}`;
document.getElementById('reroll')!.addEventListener('click', () => {
  settings.seed = 1 + Math.floor(Math.random() * 9999);
  seedEl.textContent = `#${settings.seed}`;
});

document.getElementById('go')!.addEventListener('click', () => {
  document.getElementById('start')!.hidden = true;
  game.start({ ...settings });
});

// Show a battlefield behind the menu right away.
game.start({ ...settings });
