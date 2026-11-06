"""Farming concept mockup (Blender, rendered stills only; not game assets yet).

farm_plot.png    one player's 6 x 6 plot at the in-game camera angle: tilled rows with
                 crops at different stages, a fence with a gate, an owner sign, a
                 scarecrow and the hero standing at the gate
farm_stages.png  the three starter crops (carrot, wheat, pumpkin) through their four
                 stages: seed, sprout, growing, ripe

    blender -b -P tools/blender/farm_mock.py -- <out_dir>
"""
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector

OUT = Path(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else ".").resolve()
HERO = Path(__file__).resolve().parents[2] / "game/assets3d/hero_blender.glb"
rnd = random.Random(7)


def hexc(h, a=1.0):
    h = h.lstrip("#")
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return [lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)] + [a]


MATS = {}


def mat(color, glow=0.0):
    key = (color, glow)
    if key not in MATS:
        m = bpy.data.materials.new(f"{color}{glow}")
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = hexc(color)
        b.inputs["Roughness"].default_value = 0.85
        if glow:
            b.inputs["Emission Color"].default_value = hexc(color)
            b.inputs["Emission Strength"].default_value = glow
        MATS[key] = m
    return MATS[key]


def obj_done(o, color, glow=0.0, smooth=True):
    o.data.materials.append(mat(color, glow))
    if smooth:
        bpy.ops.object.shade_smooth()
    return o


def box(size, loc, color, rot=(0, 0, 0), bevel=0.03):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    if bevel:
        m = o.modifiers.new("b", "BEVEL"); m.width = bevel; m.segments = 2
    return obj_done(o, color, smooth=False)


def cyl(r, h, loc, color, verts=12, r2=None, rot=(0, 0, 0)):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=loc, rotation=rot)
    return obj_done(bpy.context.object, color)


def ball(r, loc, color, scale=(1, 1, 1), seg=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=seg // 2, radius=r, location=loc)
    o = bpy.context.object
    o.scale = scale
    return obj_done(o, color)


def leaf(base, ang, tilt, length, color, width=0.35):
    """A flat, pointed leaf: a squashed sphere tipped out from the base."""
    x, y, z = base
    dx, dy = math.cos(ang), math.sin(ang)
    reach = length * 0.5
    c = (x + dx * reach * math.sin(tilt), y + dy * reach * math.sin(tilt), z + reach * math.cos(tilt))
    bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=6, radius=1, location=c)
    o = bpy.context.object
    o.scale = (length * width * 0.5, 0.025, length * 0.5)
    o.rotation_euler = (0, tilt, ang)
    o.rotation_mode = "ZYX"
    o.rotation_euler = (0, tilt, ang)
    return obj_done(o, color)


# ------------------------------------------------------------------ crops (origin = centre of the tile, z = soil top)

def mound(x, y, wet=False):
    ball(0.36, (x, y, -0.06), "#6a4428" if wet else "#8a5a36", scale=(1, 1, 0.4), seg=12)


def seed(x, y):
    mound(x, y, wet=True)
    for k in range(3):
        a = k * 2.1
        ball(0.035, (x + math.cos(a) * 0.08, y + math.sin(a) * 0.08, 0.09), "#f0dca0", seg=8)


def sprout(x, y, col="#7ad44a"):
    mound(x, y, wet=True)
    cyl(0.02, 0.18, (x, y, 0.15), "#5aa83a")
    for a in (0.3, 0.3 + math.pi):
        leaf((x, y, 0.22), a, 1.0, 0.18, col)


def carrot(x, y, stage):
    if stage == 0: return seed(x, y)
    if stage == 1: return sprout(x, y)
    mound(x, y)
    n, L = (5, 0.3) if stage == 2 else (8, 0.46)
    for k in range(n):  # feathery tops: a thin stalk fanning out, topped with a leaf tuft
        a, tilt = k * 2 * math.pi / n + rnd.uniform(-0.2, 0.2), 0.3 + rnd.uniform(0, 0.35)
        tip = (x + math.cos(a) * math.sin(tilt) * L, y + math.sin(a) * math.sin(tilt) * L, 0.1 + math.cos(tilt) * L)
        mid = [(0.1 * (1 - f) + t * f) if i == 2 else ((x, y)[i] * (1 - f) + t * f) for i, t, f in zip(range(3), tip, (0.5, 0.5, 0.5))]
        cyl(0.014, L, tuple(mid), "#4aa83a", verts=5, rot=(-math.sin(a) * tilt, math.cos(a) * tilt, 0))
        ball(0.07 if stage == 3 else 0.05, tip, "#4ab83a" if k % 2 else "#62cc44", scale=(1.3, 1.3, 0.7), seg=8)
    if stage == 3:  # the orange shoulder pokes out of the soil
        ball(0.15, (x, y, 0.08), "#ff8a2a", scale=(1, 1, 0.9), seg=14)
        cyl(0.15, 0.08, (x, y, 0.02), "#f47a14", verts=14)


def wheat(x, y, stage):
    if stage == 0: return seed(x, y)
    if stage == 1: return sprout(x, y, "#9ad84a")
    mound(x, y)
    ripe = stage == 3
    for k in range(9):
        a, r = k * 2.4, 0.06 + (k % 3) * 0.07
        px, py = x + math.cos(a) * r, y + math.sin(a) * r
        h = (0.45 if not ripe else 0.75) + rnd.uniform(-0.06, 0.06)
        lean = rnd.uniform(-0.12, 0.12)
        cyl(0.018, h, (px, py, h / 2), "#e0c060" if ripe else "#8ad04a", verts=6, rot=(lean, lean, 0))
        if ripe:
            ball(0.05, (px + lean * h * 0.5, py - lean * h * 0.5, h + 0.06), "#f4d26a", scale=(0.8, 0.8, 2.2), seg=8)
        else:
            leaf((px, py, h * 0.4), a, 0.6, 0.22, "#7ac844", 0.25)


def pumpkin(x, y, stage):
    if stage == 0: return seed(x, y)
    if stage == 1: return sprout(x, y, "#6ac84a")
    mound(x, y)
    for k in range(5 if stage == 2 else 6):
        a = k * 1.3
        bx, by = x + math.cos(a) * 0.18, y + math.sin(a) * 0.18
        ball(0.15 if stage == 2 else 0.19, (bx, by, 0.1), "#3f9a36" if k % 2 else "#4fb03e", scale=(1, 1, 0.35), seg=12)
    if stage == 2:
        ball(0.08, (x + 0.05, y - 0.06, 0.1), "#c8d84a", seg=12)
    else:
        for k in range(8):  # ribbed pumpkin: eight lobes in a ring
            a = k * math.pi / 4
            ball(0.16, (x + math.cos(a) * 0.1, y - 0.08 + math.sin(a) * 0.1, 0.22), "#ff8a1a" if k % 2 else "#f47a14", scale=(0.75, 0.75, 1.0), seg=12)
        cyl(0.035, 0.12, (x, y - 0.08, 0.44), "#5a7a2a", verts=6)


CROPS = {"carrot": carrot, "wheat": wheat, "pumpkin": pumpkin}


# ------------------------------------------------------------------ scenes

def plot_scene():
    # grass around, the plot's tilled soil (6 x 6 tiles, 1 tile = 1 unit), furrow lines
    cyl(30, 0.2, (0, 0, -0.1), "#6ab048", verts=48)
    box((6.2, 6.2, 0.12), (0, 0, -0.04), "#7a5232", bevel=0.05)
    for i in range(6):
        box((5.9, 0.08, 0.02), (0, -2.5 + i, 0.03), "#5e3c22", bevel=0)
    # fence with a gate gap on the south side (toward the camera, -y)
    def post(x, y):
        box((0.14, 0.14, 0.8), (x, y, 0.4), "#e0a060")
    for i in range(14):
        t = -3.3 + i * 6.6 / 13
        for x, y in ((t, 3.3), (-3.3, t), (3.3, t)):
            post(x, y)
        if abs(t) > 0.9:
            post(t, -3.3)
    for z in (0.32, 0.62):
        box((6.6, 0.06, 0.09), (0, 3.3, z), "#b0703e", bevel=0)
        for s in (-1, 1):
            box((0.06, 6.6, 0.09), (s * 3.3, 0, z), "#b0703e", bevel=0)
            box((2.4, 0.06, 0.09), (s * 2.1, -3.3, z), "#b0703e", bevel=0)
    # owner sign on a post by the gate
    cyl(0.06, 1.5, (1.3, -3.6, 0.75), "#7a4428")
    box((1.5, 0.1, 0.6), (1.3, -3.62, 1.35), "#b0703e")
    box((1.35, 0.03, 0.45), (1.3, -3.68, 1.35), "#e8c890", bevel=0)
    # scarecrow in the north-east corner
    cyl(0.05, 1.8, (2.4, 2.4, 0.9), "#7a4428")
    box((1.2, 0.06, 0.06), (2.4, 2.4, 1.35), "#7a4428", bevel=0)
    box((0.5, 0.3, 0.55), (2.4, 2.4, 1.2), "#4a7ae0")
    ball(0.2, (2.4, 2.4, 1.75), "#f0d890")
    cyl(0.32, 0.06, (2.4, 2.4, 1.9), "#c8a048", verts=16)
    cyl(0.18, 0.22, (2.4, 2.4, 2.02), "#c8a048", verts=16)
    # crops: row by row, a mix of kinds and stages
    layout = [
        ("carrot", [3, 3, 3, 2, 2, 1]),
        ("carrot", [3, 3, 2, 2, 1, 0]),
        ("wheat", [3, 3, 3, 3, 2, 2]),
        ("wheat", [2, 2, 2, 1, 1, 0]),
        ("pumpkin", [3, None, 3, None, 2, None]),
        (None, [0, 0, None, None, None, None]),
    ]
    for r, (kind, stages) in enumerate(layout):
        y = 2.5 - r
        for c, st in enumerate(stages):
            x = -2.5 + c
            if st is None:
                continue
            (CROPS[kind] if kind else carrot)(x, y, st)
    # a watering can left by the fence
    cyl(0.16, 0.26, (-2.9, -2.6, 0.13), "#5ab4ff")
    cyl(0.03, 0.3, (-2.72, -2.6, 0.26), "#5ab4ff", rot=(0, 0.9, 0))
    # the hero at the gate, looking in
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(HERO))
    root = next(o for o in bpy.data.objects if o not in before and o.parent is None)
    root.location = (0.1, -3.9, 0)
    root.rotation_euler = (0, 0, 0.2)
    root.scale = (1.1, 1.1, 1.1)


def stages_scene():
    cyl(30, 0.2, (0, 0, -0.1), "#6ab048", verts=48)
    for r, kind in enumerate(("carrot", "wheat", "pumpkin")):
        box((5.6, 0.9, 0.1), (0, 1.8 - r * 1.8, -0.03), "#7a5232", bevel=0.04)
        for st in range(4):
            CROPS[kind](-2.1 + st * 1.4, 1.8 - r * 1.8, st)


def render(path, cam_loc, target, lens, res):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x, scene.render.resolution_y = res
    if not scene.world:
        w = bpy.data.worlds.new("w"); w.use_nodes = True
        w.node_tree.nodes["Background"].inputs["Color"].default_value = hexc("#9cc8f0")
        w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
        scene.world = w
        bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), math.radians(10), math.radians(-35)))
        bpy.context.object.data.energy = 3.5
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    cam.location = cam_loc
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.lens = lens
    scene.render.filepath = str(OUT / path)
    bpy.ops.render.render(write_still=True)


OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
plot_scene()
render("farm_plot.png", (1.2, -10.5, 6.2), (0, 0.2, 0.3), 30, (1280, 720))
bpy.ops.wm.read_factory_settings(use_empty=True)
MATS.clear()
stages_scene()
render("farm_stages.png", (0, -7.5, 6.5), (0, 0, 0.1), 38, (1280, 720))
print("rendered to", OUT)
