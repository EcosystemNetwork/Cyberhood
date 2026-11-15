/* ============================================================================
   preview3d.js: a live 3D preview of a GLB-body character (the human) for the character creator.

     const p = mountPreview(stageEl, () => look);   // look: the creator's character (body, equipment)
     p.sync(visible);                                // call whenever the look or visibility changes

   It idles (with the hero's own fidgets) on a slow turntable, wearing the body's starting gear and
   the class's equipment, and only renders while visible.
   ============================================================================ */
import * as THREE from 'three';
import { loadGlbHero, makeGlbHero, loadGlbGear } from '/game/lib/glbhero.js';

export function mountPreview(stage, getLook) {
  const canvas = document.createElement('canvas');
  canvas.className = 'p3d';
  canvas.setAttribute('aria-hidden', 'true');
  const msg = document.createElement('div');
  msg.className = 'p3dmsg';
  msg.textContent = 'Loading…';
  stage.append(canvas, msg);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#fff4ff', '#3a2a48', 2.0));
  const key = new THREE.DirectionalLight('#ffffff', 2.0); key.position.set(2, 4, 3); scene.add(key);
  const rim = new THREE.DirectionalLight('#d8b8ff', 1.2); rim.position.set(-3, 2, -3); scene.add(rim);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);

  let hero = null, shown = '', visible = false, ready = false, raf = 0, last = 0, yaw = -0.5;
  const sig = (l) => JSON.stringify([l.body, l.equipment || {}]);
  function rebuild() {
    const look = getLook();
    if (hero) { hero.dispose(); hero.root.removeFromParent(); }
    hero = makeGlbHero({ body: look.body, equipment: look.equipment || {} });
    scene.add(hero.root);
    shown = sig(look);
  }
  function size() {
    const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio())) { renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    // frame a 1.55 m hero, head to toe, filling most of the stage (further back on a narrow stage)
    cam.position.set(0, 0.95, 3.5 / Math.min(1, cam.aspect));
    cam.lookAt(0, 0.8, 0);
  }
  function frame(now) {
    raf = 0;
    if (!visible || !ready) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    if (sig(getLook()) !== shown) rebuild();
    yaw += dt * 0.35;
    hero.root.rotation.y = Math.sin(yaw) * 0.6; // sway to show the front and sides, never the back
    hero.update(dt, {});
    size();
    renderer.render(scene, cam);
    raf = requestAnimationFrame(frame);
  }
  const start = () => { if (!raf && visible && ready) { last = 0; raf = requestAnimationFrame(frame); } };

  const body = getLook().body;
  Promise.all([loadGlbHero(body), loadGlbGear()]).then(() => { ready = true; msg.remove(); rebuild(); start(); })
    .catch(() => { msg.textContent = 'Could not load the 3D preview'; });

  return {
    sync(on) {
      visible = !!on;
      canvas.style.display = visible ? '' : 'none';
      msg.style.display = visible ? '' : 'none';
      if (visible) start(); else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
  };
}
