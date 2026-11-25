#!/usr/bin/env python3
"""Fetch and optimize the visual showcase's third-party assets (all CC0, from Poly Haven).

    python3 tools/showcase/fetch_assets.py            # → game/showcase/assets/

Every external asset passes through the same gate before the game sees it:
  textures  1k JPG from Poly Haven → WebP (albedo q82, normal / ARM q90). ~40-60% smaller.
  models    1k glTF → `gltf-transform optimize`: meshopt geometry, WebP textures capped at 1024,
            welded and simplified to a per-model triangle budget (MODELS), one GLB per model.
  sky       2k Radiance .hdr, used as-is (PMREM'd at load for reflections; shown as the sky).

The texture sets follow Poly Haven's packing: _diff (sRGB albedo), _nor_gl (OpenGL normal),
_arm (R = ambient occlusion, G = roughness, B = metalness: three.js reads aoMap from R and
roughness/metalness from G/B of the same texture).

KTX2 / Basis is the next step once `toktx` (KTX-Software) is on the build machine:
`gltf-transform uastc` for normals, `etc1s` for albedo; the loader in game/showcase/assets.js is
already wired for it (KTX2Loader + MeshoptDecoder).
"""
import json, os, shutil, subprocess, sys, tempfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'game/showcase/assets'
API = 'https://api.polyhaven.com'
UA = {'User-Agent': 'asset-fetch/1.0'}

TEXTURES = {  # set → what it's used for
    'cobblestone_floor_08': 'courtyard paving',
    'medieval_blocks_03': 'chapel ashlar walls, pillars, steps',
    'forrest_ground_01': 'forest floor',
    'bark_brown_02': 'procedural tree bark',
}
# model → (use, simplify ratio, simplify error). Scanned props arrive at 6-40k triangles each; scattered
# by the dozen they'd cost millions, so they're cut to a few thousand (rocks, trunk) or ~1k (fern).
MODELS = {
    'rock_moss_set_01': ('scattered mossy boulders', 0.07, 0.01),
    'fern_02': ('undergrowth', 0.18, 0.02),
    'dead_tree_trunk_02': ('fallen trunk set dressing', 0.1, 0.01),
}
HDRI = ('belfast_sunset_puresky', '2k')


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def files(asset):
    return json.loads(get(f'{API}/files/{asset}'))


def webp(src, dst, q):
    from PIL import Image
    Image.open(src).save(dst, 'WEBP', quality=q, method=6)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'tex').mkdir(exist_ok=True)
    credits = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for name, use in TEXTURES.items():
            f = files(name)
            for key, suffix, q in (('Diffuse', 'diff', 82), ('nor_gl', 'nor', 90), ('arm', 'arm', 90)):
                src = tmp / f'{name}_{suffix}.jpg'
                src.write_bytes(get(f[key]['1k']['jpg']['url']))
                webp(src, OUT / 'tex' / f'{name}_{suffix}.webp', q)
            credits.append((name, 'texture', use))
            print('texture', name)

        for name, (use, ratio, error) in MODELS.items():
            g = files(name)['gltf']['1k']['gltf']
            d = tmp / name
            (d / 'textures').mkdir(parents=True)
            (d / f'{name}.gltf').write_bytes(get(g['url']))
            for rel, v in g['include'].items():
                (d / rel).parent.mkdir(parents=True, exist_ok=True)
                (d / rel).write_bytes(get(v['url']))
            subprocess.run(['npx', '-y', '@gltf-transform/cli@4.5.1', 'optimize', str(d / f'{name}.gltf'), str(OUT / f'{name}.glb'),
                            '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '1024',
                            '--simplify-ratio', str(ratio), '--simplify-error', str(error)], check=True)
            credits.append((name, 'model', use))
            print('model', name)

        hdri, res = HDRI
        (OUT / f'{hdri}_{res}.hdr').write_bytes(get(files(hdri)['hdri'][res]['hdr']['url']))
        credits.append((hdri, 'hdri', 'sky, image-based lighting and reflections'))

    lines = ['# Showcase asset credits', '',
             'All third-party assets here are CC0 (public domain) from [Poly Haven](https://polyhaven.com).',
             'Fetched and optimized by `tools/showcase/fetch_assets.py`.', '',
             '| Asset | Kind | Used for |', '| --- | --- | --- |']
    lines += [f'| [{n}](https://polyhaven.com/a/{n}) | {k} | {u} |' for n, k, u in credits]
    lines += ['', 'Made in-house: `longsword.glb` (tools/blender/longsword.py), the chapel ruin, trees, grass,',
              'braziers and effects (procedural, game/showcase/world.js). Hero and clothing: game/assets/characterart, 3ditems.']
    (OUT / 'CREDITS.md').write_text('\n'.join(lines) + '\n')
    print('done →', OUT)


if __name__ == '__main__':
    sys.exit(main())
