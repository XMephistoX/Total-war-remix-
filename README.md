# Total War Remix

A Rome: Total War inspired strategy game: real-time battles with thousands of soldiers, and later a turn-based campaign map with cities, economy and recruitment, starting in 270 BC.

**Current phase: 1, battle test.** Animated 0 A.D. soldiers and cavalry, textured terrain, one battlefield, Rome vs Gauls.

## Run it

```bash
npm install
npm run dev        # local dev server
npm run build      # single self-contained file in dist/index.html
npm run sim -- 5   # 5 AI vs AI battles in Node, no graphics (balance + speed check)
```

## What works in the battle test

- **Thousands of soldiers**: every soldier is simulated, cheaply. Units of 80 to 300 men (Normal / Large / Huge).
- **Formations**: units keep ranks and files, wheel, about face, and you can drag a line to set width and facing.
- **Dice combat**: each soldier rolls attack vs defense. Shields only count from the front, so flank and rear hits kill far more.
- **Charges**: running into contact adds the unit's charge bonus for a few seconds. Cavalry knock men over on impact. Spearmen facing a charge brace and can unhorse riders.
- **Morale**: casualties, sudden losses, being flanked, attacked from behind, surrounded, general nearby or dead, friends fleeing, tiredness, high ground, odds. Units waver, rout, can rally, and shatter. Panic spreads.
- **Fatigue**: running, fighting and climbing drain stamina; tired units fight worse, slow down and can't run.
- **High ground**: bonus to attack, morale, and missile range. Climbing is slower and more tiring.
- **Missiles**: archers and javelins fly real arcs, can hit your own men in a melee, and run out of ammo.
- **AI**: holds, advances, charges, skirmishes with missile troops, swings cavalry around flanks and into the rear, pulls cavalry out of long fights.

## Controls (desktop)

| Action | Input |
| --- | --- |
| Select | Left click a unit, its flag or its card. Drag to box select. Shift adds. Ctrl+A all. Double click selects every unit of that type. |
| Deselect | Left click empty ground, click the selected unit again, or Esc. |
| Groups | Ctrl+1-9 saves the selection, 1-9 recalls it, press twice to move the camera there. |
| Guard mode | G or the Guard button: hold formation and don't chase. Off: men spread out and chase nearby enemies. |
| Move / attack | Right click ground / enemy. Double right click to run. R toggles run. |
| Formation | Right drag on the ground draws the front line (width and facing). |
| Halt | H |
| Camera | WASD pan, Q/E rotate, T/B or PageUp/PageDown tilt, wheel zoom, middle drag orbit, C centers on selection |
| Time | Space pause, +/- speed |

## Code layout

```
src/sim/      pure simulation (no rendering): battle.ts, ai.ts, terrain.ts, data.ts (units + factions)
src/render/   Three.js view: instanced soldiers, terrain, arrows, overlays
src/ui/       game shell: camera, input, HUD
tools/        headless battle runner and browser checks
```

The simulation runs on a fixed 20 Hz tick with a seeded RNG, so a seed always replays the same battle. All units and factions are data in `src/sim/data.ts`.

## Roadmap

1. **Battle test** (now): mechanics and feel with placeholder soldiers.
2. **Real art** (in progress): 0 A.D. soldiers, horses and animations converted by `tools/assets/zeroad_units.py`, skinned on the GPU for thousands of soldiers. Next: trees, more unit types per faction.
3. **Campaign map**: Mediterranean in 270 BC, provinces and settlements, buildings, taxes, trade, public order, recruitment by region, armies that trigger battles on the terrain where they meet.
4. **Events and factions**: Roman houses and Senate, Marian reforms that swap the Roman roster, many factions.
5. **Campaign AI**, sieges, sound and music, save/load.

## Art credits and license

Soldier, horse, animation and terrain art comes from [0 A.D.](https://play0ad.com) by Wildfire Games, licensed [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The converted files in `public/units/` and `public/terrain/` are adaptations of that art and are shared under the same license. Commercial use is allowed as long as the credit stays and changes to the art stay under CC BY-SA.

To regenerate the units, get the 0 A.D. art (`binaries/data/mods/public/art` from the 0 A.D. repository) and run:

```bash
python3 tools/assets/zeroad_units.py /path/to/0ad/binaries/data/mods/public/art [unit keys]
```
