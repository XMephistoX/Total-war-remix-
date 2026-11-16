import './style.css';
import { Game } from './ui/game';
import type { GameSettings } from './ui/game';
import type { UnitSize } from './sim/data';
import { CampaignUI, hasSave, playableFactions } from './campaign/ui';

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

// ---------------- Grand Campaign ----------------
const campaign = new CampaignUI(game);
campaign.bindHud();
(window as unknown as { __campaign: CampaignUI }).__campaign = campaign;
const pick = document.getElementById('pick')!;
bindChoice('csize', (v) => (campaign.size = v as UnitSize));
document.getElementById('goCampaign')!.addEventListener('click', () => {
  const list = document.getElementById('pickList')!;
  list.innerHTML = playableFactions()
    .map((f) => `<button class="pf" data-f="${f.id}" style="--fc:${f.color};--ft:${f.trim}"><i></i><b>${f.name}</b><small>${f.culture}</small></button>`)
    .join('');
  list.querySelectorAll<HTMLButtonElement>('.pf').forEach((b) => {
    b.onclick = () => {
      pick.hidden = true;
      void campaign.open(b.dataset.f!);
    };
  });
  document.getElementById('pickContinue')!.hidden = !hasSave();
  document.getElementById('start')!.hidden = true;
  pick.hidden = false;
});
document.getElementById('pickBack')!.addEventListener('click', () => {
  pick.hidden = true;
  document.getElementById('start')!.hidden = false;
});
document.getElementById('pickContinue')!.addEventListener('click', () => {
  pick.hidden = true;
  void campaign.open(null, true);
});

// Show a battlefield behind the menu right away.
game.start({ ...settings });
