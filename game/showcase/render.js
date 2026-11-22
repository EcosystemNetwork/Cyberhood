/* ============================================================================
   render.js: the showcase's lighting and post pipeline, one place for every knob.

   Color:    linear working space, sRGB output, AgX tone mapping (soft highlight roll-off that
             keeps fire orange instead of clipping to yellow-white). Exposure is the only grade.
   Light:    one HDR sky does three jobs: the visible sky, image-based light (PMREM) for every
             PBR surface, and the sun's colour and direction (its brightest texel). The sky is
             rotated so the sun sits where the layout wants it (low, raking from the west).
             A directional light carries the sun's shadows; nothing else casts.
   Post:     render (MSAA on high) → GTAO (contact shadow, skips grass and effects) → bloom
             (threshold above 1.0, so only HDR emissives glow: fire, eyes, magic; never
             sunlit stone) → AgX + sRGB → SMAA on low.
   Fog:      exponential distance fog, coloured from the sky's horizon so terrain melts into the
             backdrop, plus a low ground mist that pools in the hollows.
   Presets:  high (desktop) / low (mobile, or G to toggle). See QUALITY.
   ============================================================================ */
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

export const QUALITY = {
  high: { dpr: 2, msaa: 4, ao: true, shadow: 2048, shadowSpan: 34, bloomRes: 0.5, grass: 1, lights: 4, smaa: false },
  low: { dpr: 1.25, msaa: 0, ao: false, shadow: 1024, shadowSpan: 26, bloomRes: 0.33, grass: 0.3, lights: 2, smaa: true },
};

// the look: tuned against the belfast_sunset sky (see ART_DIRECTION.md)
export const LOOK = {
  exposure: 0.8,
  envIntensity: 0.55,     // sky light on PBR surfaces
  skyIntensity: 0.62,     // the visible sky behind everything
  sunIntensity: 3.4,
  sunAzimuth: 2.6,        // rad, where the sun is placed (atan2(z, x)); the chapel faces +z
  sunMinElev: 0.2,        // rad; the sky's own sun is near the horizon, raise the light a little so shadows stay readable
  fogDensity: 0.0085,
  fogLuma: 0.075,         // fog brightness (linear luminance); the horizon's hue, at dusk-under-trees brightness
  mist: { density: 0.035, height: 1.4, base: -0.4 }, // ground mist: extra fog under `height` m
  bloom: { strength: 0.55, radius: 0.55, threshold: 1.05 },
  ao: { radius: 0.55, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: 12 },
};

export const isTouch = matchMedia('(pointer: coarse)').matches;

// ---- height mist: patch the fog chunks once, before any material compiles
THREE.ShaderChunk.fog_pars_vertex = '#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vFogWorld;\n#endif';
THREE.ShaderChunk.fog_vertex = '#ifdef USE_FOG\n vFogDepth = - mvPosition.z;\n vFogWorld = (inverse(viewMatrix) * mvPosition).xyz;\n#endif';
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
 uniform vec3 fogColor;
 varying float vFogDepth;
 varying vec3 vFogWorld;
 #ifdef FOG_EXP2
  uniform float fogDensity;
 #else
  uniform float fogNear;
  uniform float fogFar;
 #endif
#endif`;
const M = LOOK.mist;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
 #ifdef FOG_EXP2
  float mistH = clamp((${M.height.toFixed(2)} - vFogWorld.y) / ${(M.height - M.base).toFixed(2)}, 0.0, 1.0);
  float mistD = ${M.density.toFixed(3)} * mistH * mistH * clamp(vFogDepth / 22.0, 0.0, 1.0);
  float fogFactor = 1.0 - exp(- (fogDensity * fogDensity * vFogDepth * vFogDepth) - mistD * vFogDepth * 0.08);
 #else
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
 #endif
 gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
#endif`;

export function createRenderer(canvas, qName) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LOOK.exposure;
  renderer.shadowMap.enabled = true;
  renderer.info.autoReset = false; // the composer renders many passes per frame; count them all
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 400);
  scene.fog = new THREE.FogExp2(0x8a8f9c, LOOK.fogDensity);

  // sun
  const sun = new THREE.DirectionalLight(0xffffff, LOOK.sunIntensity);
  sun.castShadow = true;
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);
  const sunDir = new THREE.Vector3(0.5, 0.4, 0.5).normalize();

  // things GTAO's normal pass should not see (grass blades, particles, trails): they'd smear dark halos
  const noAO = new Set();

  let q = QUALITY[qName], composer, gtao, bloom, smaa, renderPass;
  function build() {
    q = QUALITY[qName];
    composer?.dispose?.();
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q.dpr));
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: q.msaa });
    composer = new EffectComposer(renderer, rt);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    gtao = null;
    if (q.ao) {
      gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
      gtao.updateGtaoMaterial(LOOK.ao);
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      gtao.blendIntensity = 0.9;
      const raw = gtao.render.bind(gtao);
      gtao.render = (...a) => { // hide what shouldn't occlude for the AO passes only
        const hidden = [];
        for (const o of noAO) if (o.visible) { o.visible = false; hidden.push(o); }
        raw(...a);
        for (const o of hidden) o.visible = true;
      };
      composer.addPass(gtao);
    }
    bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth * q.bloomRes, innerHeight * q.bloomRes), LOOK.bloom.strength, LOOK.bloom.radius, LOOK.bloom.threshold);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    smaa = null;
    if (q.smaa) { smaa = new SMAAPass(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio()); composer.addPass(smaa); }
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    sun.shadow.map?.dispose(); sun.shadow.map = null;
    const s = q.shadowSpan;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 160 });
    sun.shadow.camera.updateProjectionMatrix();
    resize();
  }
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  build();

  // shadows follow the focus point, snapped to whole shadow texels so edges don't crawl
  const _f = new THREE.Vector3();
  function followSun(focus) {
    const span = q.shadowSpan * 2, texel = span / q.shadow;
    _f.copy(focus);
    // snap in light space
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), sunDir.clone().negate(), new THREE.Vector3(0, 1, 0));
    const inv = m.clone().invert();
    _f.applyMatrix4(inv);
    _f.x = Math.round(_f.x / texel) * texel; _f.y = Math.round(_f.y / texel) * texel;
    _f.applyMatrix4(m);
    sun.target.position.copy(_f);
    sun.position.copy(_f).addScaledVector(sunDir, 80);
    sun.target.updateMatrixWorld();
  }

  return {
    renderer, scene, camera, sun, sunDir, noAO,
    get quality() { return qName; },
    setQuality(n) { qName = n; build(); },
    get q() { return q; },
    followSun,
    render() { renderer.info.reset(); composer.render(); },
  };
}

/* ---- the sky: load, rotate so the sun lands at LOOK.sunAzimuth, read sun + horizon colour ---- */
export async function loadSky(R, url, onProgress) {
  const tex = await new RGBELoader().setDataType(THREE.FloatType).loadAsync(url, onProgress);
  const { width: W, height: H, data } = tex.image;
  // brightest texel above the horizon = the sun
  let best = -1, bi = 0, bj = 0;
  for (let j = 0; j < H / 2; j++) for (let i = 0; i < W; i++) {
    const k = (j * W + i) * 4, l = data[k] * 0.2126 + data[k + 1] * 0.7152 + data[k + 2] * 0.0722;
    if (l > best) { best = l; bi = i; bj = j; }
  }
  // equirect: u = atan(z, x) / 2π + .5, v = asin(y) / π + .5; row 0 is the top (v = 1)
  const phi0 = ((bi + 0.5) / W - 0.5) * Math.PI * 2;
  const shift = Math.round(((LOOK.sunAzimuth - phi0) / (Math.PI * 2)) * W);
  const out = new Float32Array(data.length);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const s = (j * W + i) * 4, d = (j * W + ((i + shift) % W + W) % W) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 1;
  }
  tex.image.data = out;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;

  const lat = (0.5 - (bj + 0.5) / H) * Math.PI, elev = Math.max(lat, LOOK.sunMinElev);
  R.sunDir.set(Math.cos(LOOK.sunAzimuth) * Math.cos(elev), Math.sin(elev), Math.sin(LOOK.sunAzimuth) * Math.cos(elev)).normalize();
  // sun colour: the average around the sun texel, normalised (its brightness is the light's intensity)
  const avg = (j0, j1, i0, i1) => {
    const c = [0, 0, 0]; let n = 0;
    for (let j = Math.max(0, j0); j < Math.min(H, j1); j++) for (let i = i0; i < i1; i++) {
      const k = (j * W + ((i % W) + W) % W) * 4; c[0] += out[k]; c[1] += out[k + 1]; c[2] += out[k + 2]; n++;
    }
    return c.map((x) => x / n);
  };
  const sc = avg(bj - 3, bj + 4, bi + shift - 3, bi + shift + 4), m = Math.max(...sc);
  R.sun.color.setRGB(sc[0] / m, (sc[1] / m) * 0.97, (sc[2] / m) * 0.92);
  // horizon band → fog, averaged all round (a touch darker: fog sits in shade under the trees)
  const hz = avg(Math.floor(H * 0.47), Math.floor(H * 0.5), 0, W), hl = hz[0] * 0.2126 + hz[1] * 0.7152 + hz[2] * 0.0722;
  R.scene.fog.color.setRGB(...hz.map((c) => (c / hl) * LOOK.fogLuma));

  const pmrem = new THREE.PMREMGenerator(R.renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  R.scene.environment = env;
  R.scene.background = tex;
  R.scene.backgroundIntensity = LOOK.skyIntensity;
  return { tex, env };
}
