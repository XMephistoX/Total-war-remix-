// Renders each converted unit in several animation frames, for checking the asset pipeline.
import * as THREE from 'three';
import { Crowd, loadUnitAsset } from '../../src/render/crowd';

const keys = (new URLSearchParams(location.search).get('units') ?? 'rome_hastati').split(',');
const clips = ['idle', 'ready', 'walk', 'run', 'attack1', 'attack2', 'death1', 'shoot'];
const canvas = document.getElementById('c') as HTMLCanvasElement;
const r = new THREE.WebGLRenderer({ canvas, antialias: true });
r.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8899aa);
scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(3, 6, 8);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x667744 }));
scene.add(ground);
const cam = new THREE.PerspectiveCamera(35, 1400 / 800, 0.1, 200);
(async () => {
  let row = 0;
  for (const key of keys) {
    const asset = await loadUnitAsset(key, '/public/units/');
    if (!asset) continue;
    const crowd = new Crowd(asset, clips.length);
    const m = new THREE.Matrix4();
    clips.forEach((c, i) => {
      // Face the camera (+z) and show the frame 40% into each clip.
      m.makeTranslation(i * 1.6 - (clips.length - 1) * 0.8, 0, -row * 3);
      crowd.mesh.setMatrixAt(i, m);
      const info = asset.meta.clips[c];
      crowd.frames.setX(i, info ? info.start + Math.floor(info.count * 0.4) : 0);
      crowd.setTeam(i, new THREE.Color(key.startsWith('rome') ? 0xa3221c : key.startsWith('gaul') ? 0x2c5ca0 : [0x6b3fa0, 0xd4a017, 0x2b8fc9, 0xb8862b][row % 4]));
    });
    crowd.mesh.instanceMatrix.needsUpdate = true;
    crowd.frames.needsUpdate = true;
    scene.add(crowd.mesh);
    row++;
  }
  cam.position.set(0, 2.2, 7 + row * 1.5);
  cam.lookAt(0, 0.9, -(row - 1) * 1.5);
  r.render(scene, cam);
  (window as any).__done = true;
})();
