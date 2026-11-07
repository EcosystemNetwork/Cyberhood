"""Terraced block terrain style test (Blender, rendered stills only; not game assets yet).

Soft, chunky blocks stacked into stepped terraces with grass caps and striped earth sides,
instead of the tall spiky backdrop mountains. Distant hills are big pale stepped blocks.

terrain_town.png    our town edge (cottage, trees, hero) ringed by green terraces
terrain_desert.png  the same idea as a desert mesa zone: yellow grass caps, sand strata, dead trees
terrain_kit.png     the pieces: grass block, terrace corner, stairs, tall grass, flower bed,
                    boulder, dead tree, chunky bush, pond edge

    blender -b -P tools/blender/terrain_mock.py -- <out_dir>
"""
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector, noise

OUT = Path(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else ".").resolve()
ASSETS = Path(__file__).resolve().parents[2] / "game/assets3d"
STEP = 0.6  # one terrace level, in tiles
G = STEP  # top of the flat ground (one level)


def hexc(h, a=1.0):
    h = h.lstrip("#")
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return [lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)] + [a]


MATS = {}


def mat(color, rough=0.9, grain=0.12, glow=0.0, coords="Generated", scale=6.0):
    """Flat colour with a soft painted grain (noise in object space), so big faces aren't dead flat."""
    key = (color, grain, glow, coords, scale)
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new(color)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = rough
    if grain:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = scale
        nt.links.new(tc.outputs[coords], nz.inputs["Vector"])
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        c = hexc(color)
        ramp.color_ramp.elements[0].color = [v * (1 - grain) for v in c[:3]] + [1]
        ramp.color_ramp.elements[1].color = [min(1, v * (1 + grain)) for v in c[:3]] + [1]
        nt.links.new(nz.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    else:
        b.inputs["Base Color"].default_value = hexc(color)
    if glow:
        b.inputs["Emission Color"].default_value = hexc(color)
        b.inputs["Emission Strength"].default_value = glow
    MATS[key] = m
    return m


MESHES = {}


def block_mesh(name, size, color, bevel=0.08, grain=0.12):
    """A beveled box mesh made once and shared by every block that uses it."""
    if name in MESHES:
        return MESHES[name]
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        m = o.modifiers.new("b", "BEVEL"); m.width = bevel; m.segments = 3
        bpy.ops.object.modifier_apply(modifier="b")
    bpy.ops.object.shade_smooth()
    o.data.materials.append(mat(color, grain=grain))
    me = o.data
    bpy.data.objects.remove(o)
    MESHES[name] = me
    return me


def place(me, loc, rot=0.0, scale=1.0):
    o = bpy.data.objects.new("b", me)
    o.location = loc
    o.rotation_euler = (0, 0, rot)
    o.scale = (scale, scale, scale)
    bpy.context.collection.objects.link(o)
    return o


def box(size, loc, color, rot=(0, 0, 0), bevel=0.04, grain=0.08):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    if bevel:
        m = o.modifiers.new("b", "BEVEL"); m.width = bevel; m.segments = 2
    o.data.materials.append(mat(color, grain=grain))
    return o


def cyl(r, h, loc, color, verts=10, r2=None, rot=(0, 0, 0)):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=loc, rotation=rot)
    o = bpy.context.object
    o.data.materials.append(mat(color, grain=0.06))
    return o


def ball(r, loc, color, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=r, location=loc)
    o = bpy.context.object
    o.scale = scale
    o.data.materials.append(mat(color, grain=0.1))
    bpy.ops.object.shade_smooth()
    return o


def gltf(name, loc, rot=0.0, scale=1.0):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(ASSETS / f"{name}.glb"))
    root = next(o for o in bpy.data.objects if o not in before and o.parent is None)
    root.location = loc
    root.rotation_euler = (0, 0, rot)
    root.scale = (scale, scale, scale)
    return root


# ------------------------------------------------------------------ palettes

GREEN = dict(top="#7cbf4a", lip="#4f8f2e", side=("#c49a68", "#a87e52", "#b88e5e"), path="#e6d2a6", far="#aeb0e0", sky="#9fd0f4", tuft="#4f9a34")
DESERT = dict(top="#d8b440", lip="#a87a20", side=("#e2c088", "#c09060", "#d4a870"), path="#efe0c0", far="#aeb0e6", sky="#a8d8f8", tuft="#8a6a40")


def kit(pal):
    """The shared block meshes for one palette: earth blocks in three strata tones and a grass cap."""
    earth = [block_mesh(f"earth{i}{pal['top']}", (1.0, 1.0, STEP), c, bevel=0.07) for i, c in enumerate(pal["side"])]
    cap = block_mesh(f"cap{pal['top']}", (1.06, 1.06, 0.16), pal["top"], bevel=0.06, grain=0.1)
    lip = block_mesh(f"lip{pal['top']}", (1.03, 1.03, 0.1), pal["lip"], bevel=0.04, grain=0.05)
    return earth, cap, lip


def column(k, x, y, h, top=True):
    """A stack of h earth blocks (strata tone by level) with a grass cap on top."""
    earth, cap, lip = k
    for lv in range(h):
        place(earth[(lv + (1 if lv > 2 else 0)) % 3], (x, y, lv * STEP + STEP / 2))
    if top:
        place(lip, (x, y, h * STEP - 0.03))
        place(cap, (x, y, h * STEP + 0.05))


def heights(W, H, play, seed, maxh=12, back=1.1, side=1.6, front=2.6):
    """Terraces: flat inside the play box, climbing in steps away from it (steepest at the back),
    with chunky noise quantised in 2 x 2 groups so the steps read as broad ledges."""
    x0, y0, x1, y1 = play
    hm = {}
    for gy in range(H):
        for gx in range(W):
            x, y = gx - W / 2 + 0.5, gy - H / 2 + 0.5
            d = max((y - y1) / back, max(x0 - x, x - x1) / side, (y0 - y) / front, 0)
            n = noise.noise(Vector((gx * 0.13 + seed, gy * 0.13, 0.5)))
            q = noise.noise(Vector(((gx // 2) * 0.31 + seed, (gy // 2) * 0.31, 2.0)))
            h = 0 if d <= 0 else max(0, int(min(maxh, d + n * 1.4 + q * 1.4 + 0.6)))
            hm[(gx, gy)] = h if h <= 1 else min(maxh, (h // 2) * 2 + (1 if q > 0.35 else 0))  # ledges in 2-3 level cliffs
    return hm


def strata_mat(pal):
    """Cliff sides: horizontal bands, one tone per terrace level, with a soft grain."""
    key = ("strata", pal["top"])
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new("strata")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = 0.95
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs["Vector"])
    div = nt.nodes.new("ShaderNodeMath"); div.operation = "DIVIDE"; div.inputs[1].default_value = STEP
    nt.links.new(sep.outputs["Z"], div.inputs[0])
    fl = nt.nodes.new("ShaderNodeMath"); fl.operation = "FLOOR"
    nt.links.new(div.outputs["Value"], fl.inputs[0])
    md = nt.nodes.new("ShaderNodeMath"); md.operation = "FLOORED_MODULO"; md.inputs[1].default_value = 3
    nt.links.new(fl.outputs["Value"], md.inputs[0])
    sc = nt.nodes.new("ShaderNodeMath"); sc.operation = "DIVIDE"; sc.inputs[1].default_value = 3
    nt.links.new(md.outputs["Value"], sc.inputs[0])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, hexc(pal["side"][0])
    els[1].position, els[1].color = 0.3, hexc(pal["side"][1])
    e = els.new(0.63); e.color = hexc(pal["side"][2])
    nt.links.new(sc.outputs["Value"], ramp.inputs["Fac"])
    nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 9.0
    nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 0.18
    nt.links.new(ramp.outputs["Color"], mix.inputs["A"])
    nt.links.new(nz.outputs["Color"], mix.inputs["B"])
    nt.links.new(mix.outputs["Result"], b.inputs["Base Color"])
    MATS[key] = m
    return m


def build_terrain(pal, W, H, play, seed, **kw):
    """One merged mesh: continuous grass tops, side walls cut per level (so edges line up), and a
    grass lip overhanging every ledge. A bevel rounds only the outer edges."""
    import bmesh
    hm = heights(W, H, play, seed, **kw)
    lvl = lambda gx, gy: max(1, hm.get((gx, gy), 0)) if 0 <= gx < W and 0 <= gy < H else 0
    bm = bmesh.new()
    vc = {}
    def v(x, y, z):
        k = (round(x, 4), round(y, 4), round(z, 4))
        if k not in vc:
            vc[k] = bm.verts.new(k)
        return vc[k]
    def quad(pts, mi):
        f = bm.faces.new([v(*p) for p in pts])
        f.material_index = mi
    tops = []
    for (gx, gy) in hm:
        h = lvl(gx, gy)
        x0, y0 = gx - W / 2, gy - H / 2
        x1, y1, z = x0 + 1, y0 + 1, h * STEP
        quad([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], 0)
        tops.append((x0 + 0.5, y0 + 0.5, z, hm[(gx, gy)]))
        for (dx, dy, a, b) in ((0, -1, (x0, y0), (x1, y0)), (1, 0, (x1, y0), (x1, y1)), (0, 1, (x1, y1), (x0, y1)), (-1, 0, (x0, y1), (x0, y0))):
            nh = lvl(gx + dx, gy + dy)
            for l in range(nh, h):
                quad([(a[0], a[1], l * STEP), (b[0], b[1], l * STEP), (b[0], b[1], (l + 1) * STEP), (a[0], a[1], (l + 1) * STEP)], 1)
            if nh < h and nh > 0:  # grass lip along the ledge
                ox, oy = dx * 0.05, dy * 0.05
                cx, cy = (a[0] + b[0]) / 2 + ox, (a[1] + b[1]) / 2 + oy
                lx, ly = (0.53, 0.06) if dy else (0.06, 0.53)
                zt, zb = z + 0.06, z - 0.12
                c = [(cx - lx, cy - ly), (cx + lx, cy - ly), (cx + lx, cy + ly), (cx - lx, cy + ly)]
                vb = [bm.verts.new((px, py, zb)) for px, py in c]
                vt = [bm.verts.new((px, py, zt)) for px, py in c]
                for f in [vt, vb[::-1]] + [[vb[i], vb[(i + 1) % 4], vt[(i + 1) % 4], vt[i]] for i in range(4)]:
                    bm.faces.new(f).material_index = 2
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("terrain")
    bm.to_mesh(me)
    bm.free()
    for m in (mat(pal["top"], grain=0.14, coords="Object", scale=0.9), strata_mat(pal), mat(pal["lip"], grain=0.08, coords="Object", scale=2.0)):
        me.materials.append(m)
    o = bpy.data.objects.new("terrain", me)
    bpy.context.collection.objects.link(o)
    bv = o.modifiers.new("b", "BEVEL"); bv.width = 0.09; bv.segments = 2; bv.limit_method = "ANGLE"
    o.data.polygons.foreach_set("use_smooth", [False] * len(o.data.polygons))
    return hm, tops


def far_hills(pal, seed, ring=(70, 110), n=13):
    """Big pale stepped blocks on the horizon (instead of spiky peaks)."""
    rnd = random.Random(seed)
    m = [block_mesh(f"far{i}{pal['far']}", (s, s, 2.2), c, bevel=0.3, grain=0.04)
         for i, (s, c) in enumerate(((5, pal["far"]), (5, "#c2c4ea")))]
    for i in range(n):
        a = math.pi * (0.15 + 0.7 * i / (n - 1)) + rnd.uniform(-0.06, 0.06)
        r = rnd.uniform(*ring)
        cx, cy = math.cos(a) * r, math.sin(a) * r
        tiers = rnd.randint(4, 8)
        for t in range(tiers):
            span = tiers - t
            for ix in range(-span + 1, span):
                for iy in range(-span + 1, span):
                    if rnd.random() < 0.82:
                        place(m[(t + ix) % 2], (cx + ix * 5, cy + iy * 5, t * 2.2 + 1.1))


# ------------------------------------------------------------------ props

def tall_grass(x, y, z, w=1.0, d=1.0, col="#5fb83e"):
    """A chunky patch of tall grass: dense thin blades filling a block-shaped footprint."""
    rnd = random.Random(int(x * 100 + y))
    for _ in range(int(26 * w * d)):
        px, py = x + rnd.uniform(-w / 2, w / 2) * 0.95, y + rnd.uniform(-d / 2, d / 2) * 0.95
        h = rnd.uniform(0.45, 0.65)
        bpy.ops.mesh.primitive_cone_add(vertices=3, radius1=0.06, radius2=0.0, depth=h, location=(px, py, z + h / 2),
                                        rotation=(rnd.uniform(-0.15, 0.15), rnd.uniform(-0.15, 0.15), rnd.uniform(0, 6)))
        bpy.context.object.data.materials.append(mat(col if rnd.random() < 0.7 else "#7ad04a", grain=0.05))


def flower_bed(x, y, z, w=2, d=1):
    box((w, d, 0.12), (x, y, z + 0.06), "#6aa83e", bevel=0.04)
    rnd = random.Random(int(x * 31 + y * 7))
    for _ in range(int(18 * w * d)):
        px, py = x + rnd.uniform(-w / 2 + 0.1, w / 2 - 0.1), y + rnd.uniform(-d / 2 + 0.1, d / 2 - 0.1)
        cyl(0.012, 0.16, (px, py, z + 0.2), "#4a8a2a", verts=4)
        ball(0.05, (px, py, z + 0.3), rnd.choice(["#ffb0c8", "#ffffff", "#ff7aa8", "#ffe07a"]))


def boulder(x, y, z, s=1.0, col="#b8b4ae"):
    box((0.8 * s, 0.7 * s, 0.55 * s), (x, y, z + 0.27 * s), col, rot=(0, 0, s), bevel=0.15 * s)
    box((0.45 * s, 0.4 * s, 0.35 * s), (x + 0.35 * s, y - 0.25 * s, z + 0.18 * s), col, rot=(0, 0, 0.6), bevel=0.1 * s)


def dead_tree(x, y, z, s=1.0, col="#8a7e72"):
    cyl(0.14 * s, 1.0 * s, (x, y, z + 0.5 * s), col, verts=7, r2=0.09 * s)
    for a, t in ((0.4, 0.7), (2.6, 0.6), (4.4, 0.8)):
        L = 0.45 * s
        cyl(0.06 * s, L, (x + math.cos(a) * 0.15 * s, y + math.sin(a) * 0.15 * s, z + (0.75 + t * 0.2) * s), col, verts=5, r2=0.03 * s,
            rot=(-math.sin(a) * t, math.cos(a) * t, 0))


def bush(x, y, z, s=1.0, col="#4f9a34"):
    for dx, dy, r in ((0, 0, 0.35), (0.25, 0.1, 0.25), (-0.22, 0.08, 0.27), (0.05, -0.2, 0.24)):
        ball(r * s, (x + dx * s, y + dy * s, z + r * s * 0.8), col)


def stairs(x, y, z, steps=3, rot=0.0, col="#d8c8a8"):
    for i in range(steps):
        box((1.0, 0.33, STEP / steps * (i + 1)), (x + math.sin(rot) * i * 0.33, y + math.cos(rot) * i * 0.33, z + STEP / steps * (i + 1) / 2),
            col, rot=(0, 0, -rot), bevel=0.03)


def tile_path(x0, y0, x1, y1, z, col):
    for gx in range(x0, x1):
        for gy in range(y0, y1):
            box((0.96, 0.96, 0.04), (gx + 0.5, gy + 0.5, z + 0.02), col, bevel=0.02, grain=0.05)


# ------------------------------------------------------------------ scenes

def world(pal, mist=True):
    scene = bpy.context.scene
    w = bpy.data.worlds.new("w")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = hexc(pal["sky"])
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = w
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(48), math.radians(12), math.radians(-40)))
    bpy.context.object.data.energy = 3.2
    bpy.context.object.data.angle = math.radians(8)
    # clouds: soft white puffs high up
    rnd = random.Random(3)
    for i in range(7):
        cx, cy, cz = rnd.uniform(-40, 40), rnd.uniform(30, 70), rnd.uniform(16, 24)
        for k in range(4):
            ball(rnd.uniform(1.6, 2.6), (cx + k * 2.0 - 3, cy, cz + rnd.uniform(-0.3, 0.5)), "#ffffff", scale=(1.3, 1, 0.7))


def town_scene():
    pal = GREEN
    hm, tops = build_terrain(pal, 56, 44, (-9, -14, 9, 3), seed=4.0)
    far_hills(pal, 9)
    world(pal)
    tile_path(-1, -17, 1, 4, G, pal["path"])
    tile_path(-9, -4, 9, -2, G, pal["path"])
    gltf("cottage", (-5, 0.5, G), rot=0.0, scale=0.95)
    gltf("cottage", (5.2, 0.8, G), rot=0.15, scale=0.9)
    gltf("hero_blender", (0.2, -8.5, G), rot=0.3, scale=1.1)
    rnd = random.Random(5)
    for (x, y, z, h) in tops:  # trees on some terrace tops, tall grass and flowers below
        clump = noise.noise(Vector((x * 0.18, y * 0.18, 7.0))) > 0.15
        if h >= 2 and clump and rnd.random() < 0.16:
            gltf(rnd.choice(["tree_round", "tree_pine", "tree_oak"]), (x, y, z - 0.05), rot=rnd.uniform(0, 6), scale=rnd.uniform(0.75, 1.0))
        elif h >= 1 and rnd.random() < 0.025:
            bush(x, y, z, rnd.uniform(0.8, 1.1))
    tall_grass(-6.5, -8, G, 3, 2)
    tall_grass(6.5, -9, G, 2, 3)
    flower_bed(-3.5, -5.6, G, 3, 1)
    flower_bed(3.8, -5.6, G, 3, 1)
    boulder(7.5, -2.5, G, 0.9)
    # a pond with block edges
    box((4.2, 2.8, 0.1), (-6.5, -11.8, G - 0.04), "#5ab4e8", bevel=0.03, grain=0.15)
    for dx in (-2.2, 2.2):
        box((0.3, 3.0, 0.3), (-6.5 + dx, -11.8, G + 0.1), "#d8d4cc", bevel=0.06)
    return (1.5, -24, 10.5), (0, 2, 3.0), 26


def desert_scene():
    pal = DESERT
    hm, tops = build_terrain(pal, 56, 44, (-8, -14, 8, 1), seed=11.0, maxh=14, back=0.9)
    far_hills(pal, 21)
    world(pal)
    tile_path(-1, -17, 1, 2, G, "#e8907a")
    tile_path(-8, -6, 8, -4, G, "#e8907a")
    rnd = random.Random(8)
    for (x, y, z, h) in tops:
        r = rnd.random()
        if h >= 2 and r < 0.018:
            dead_tree(x, y, z, rnd.uniform(0.9, 1.3))
        elif h >= 1 and r < 0.05:
            tall_grass(x, y, z, 0.6, 0.6, "#8a6a40")
    for (x, y) in ((-5, -1), (-3.8, -1), (-5, 0.2)):
        box((1.0, 1.0, 1.0), (x, y, G + 0.5), "#8a5a36", bevel=0.06)  # crates
    box((1.0, 1.0, 1.0), (-3.8, 0.2, G + 0.5), "#f0f0f0", bevel=0.06)
    boulder(5, -2, G, 1.2, "#c8c0b4")
    gltf("hero_blender", (0.2, -9, G), rot=0.3, scale=1.1)
    for i in range(4):  # a little wooden deck and a fence line
        box((3.6, 0.8, 0.1), (4.5, 1.5 - i * 0.82, G + 0.06), "#d89a5a" if i % 2 else "#c88a4a", bevel=0.03)
    stairs(0, 2.2, G, 3)
    return (1.5, -24, 10.5), (0, 2, 3.0), 26


def kit_scene():
    pal = GREEN
    k = kit(pal)
    box((40, 20, 0.2), (0, 2, -0.1), "#9cd06a", bevel=0)
    world(pal)
    # 1 grass block, 2 terrace corner, 3 stairs into a terrace, 4 tall grass, 5 flower bed,
    # 6 boulder, 7 bush, 8 dead tree, 9 pond edge
    column(k, -12, 0, 1)
    for (x, y, h) in ((-9, 0, 1), (-8, 0, 2), (-9, 1, 2), (-8, 1, 3), (-7, 0, 1), (-7, 1, 2), (-9, -1, 1), (-8, -1, 1), (-7, -1, 1)):
        column(k, x, y, h)
    for (x, y) in ((-4, 1), (-3, 1), (-4, 2), (-3, 2)):
        column(k, x, y, 2)
    stairs(-3.5, -0.2, 0.0, 3, col="#e0d0b0")
    box((1.0, 0.6, STEP), (-3.5, 0.5, STEP * 1.5), "#e0d0b0", bevel=0.03)
    tall_grass(0, 0.5, 0, 1.6, 1.6)
    flower_bed(3, 0.5, 0, 2, 1)
    boulder(6, 0.5, 0)
    bush(8.5, 0.5, 0)
    dead_tree(11, 0.5, 0)
    box((2.2, 1.6, 0.06), (14, 0.5, 0.03), "#5ab4e8", bevel=0.02, grain=0.15)
    for dy in (-0.95, 0.95):
        box((2.6, 0.3, 0.3), (14, 0.5 + dy, 0.15), "#d8d4cc", bevel=0.06)
    gltf("tree_round", (-12, 3.5, 0), scale=0.9)
    gltf("tree_pine", (-9, 3.8, 0), scale=0.9)
    return (1.5, -23, 10), (1.5, 0.8, 0.6), 30


def render(path, cam_loc, target, lens):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x, scene.render.resolution_y = 1600, 900
    if hasattr(scene.eevee, "use_shadows"):
        scene.eevee.use_shadows = True
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    cam.location = cam_loc
    cam.rotation_euler = (Vector(target) - Vector(cam_loc)).to_track_quat("-Z", "Y").to_euler()
    cam_data.lens = lens
    cam_data.clip_end = 400
    scene.render.filepath = str(OUT / path)
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    only = sys.argv[sys.argv.index("--") + 2:] if "--" in sys.argv else []
    for name, fn in (("terrain_town.png", town_scene), ("terrain_desert.png", desert_scene), ("terrain_kit.png", kit_scene)):
        if only and name.split("_")[1].split(".")[0] not in only:
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        MATS.clear(); MESHES.clear()
        cam, target, lens = fn()
        render(name, cam, target, lens)
    print("rendered to", OUT)
