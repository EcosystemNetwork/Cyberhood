"""Plot buildings concept mockup (Blender, rendered stills only; not game assets yet).

build_items.png  the altar (2 x 2 tiles) and the clubhouse (3 x 3 tiles) side by side
build_plot.png   an 8 x 8 owned plot with crops, a clubhouse and an altar placed on it
build_mode.png   the same plot in build mode: tile grid on the soil and a see-through
                 green altar where it would be placed

    blender -b -P tools/blender/build_mock.py -- <out_dir>
"""
import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from farm_mock import OUT, HERO, MATS, box, cyl, ball, mat, hexc, render, CROPS  # noqa: E402

N = 8  # plot size in tiles


def ghost_mat():
    m = bpy.data.materials.new("ghost")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = hexc("#7aff6a")
    b.inputs["Emission Color"].default_value = hexc("#7aff6a")
    b.inputs["Emission Strength"].default_value = 1.2
    b.inputs["Alpha"].default_value = 0.45
    for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        if hasattr(m, attr):
            setattr(m, attr, val)
    return m


def glow(color, strength=6):
    return mat(color, strength)


def altar(x, y, ghost=None):
    """2 x 2 stone altar: stepped base, pedestal, floating crystal, candles and a rune ring."""
    made = []
    def keep(o):
        made.append(o)
        return o
    keep(box((1.8, 1.8, 0.2), (x, y, 0.1), "#a8a296", bevel=0.05))
    keep(box((1.3, 1.3, 0.2), (x, y, 0.3), "#bcb6aa", bevel=0.05))
    keep(cyl(0.32, 0.7, (x, y, 0.75), "#d8d2c4", verts=8, r2=0.26))
    keep(cyl(0.42, 0.12, (x, y, 1.14), "#bcb6aa", verts=8))
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.26, location=(x, y, 1.62))
    o = bpy.context.object
    o.scale = (1, 1, 1.7)
    o.rotation_euler = (0, 0, 0.4)
    o.data.materials.append(glow("#5affd8", 5))
    keep(o)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.85, minor_radius=0.035, location=(x, y, 0.42))
    bpy.context.object.data.materials.append(glow("#5affd8", 4))
    keep(bpy.context.object)
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        cx, cy = x + sx * 0.55, y + sy * 0.55
        keep(cyl(0.05, 0.22, (cx, cy, 0.51), "#f4ecd8", verts=8))
        keep(ball(0.04, (cx, cy, 0.66), "#ffc040", scale=(1, 1, 1.6), seg=8))
        MATS_GLOW = glow("#ffb030", 8)
        made[-1].data.materials[0] = MATS_GLOW
    keep(cyl(0.16, 0.08, (x + 0.45, y - 0.62, 0.44), "#8a5a36", verts=12))  # offering bowl
    keep(ball(0.07, (x + 0.45, y - 0.62, 0.5), "#ff8a2a", seg=8))
    if ghost:
        for o in made:
            o.data.materials.clear()
            o.data.materials.append(ghost)
    if not ghost:
        bpy.ops.object.light_add(type="POINT", location=(x, y, 1.7))
        bpy.context.object.data.energy = 40
        bpy.context.object.data.color = (0.4, 1.0, 0.85)


def clubhouse(x, y, roof="#c4553a", flag="#ff3fb4"):
    """3 x 3 timber clubhouse: stone footing, plank walls, pitched roof, porch, door, windows, flag."""
    W, D, H = 2.6, 2.3, 1.55
    box((W + 0.2, D + 0.2, 0.25), (x, y, 0.12), "#8c8478", bevel=0.05)
    box((W, D, H), (x, y, 0.25 + H / 2), "#d8a46a", bevel=0.03)
    for i in range(6):  # plank seams on the front
        box((0.03, 0.02, H), (x - W / 2 + 0.25 + i * 0.43, y - D / 2 - 0.005, 0.25 + H / 2), "#a87444", bevel=0)
    for sx in (-1, 1):  # corner posts
        for sy in (-1, 1):
            box((0.16, 0.16, H + 0.05), (x + sx * W / 2, y + sy * D / 2, 0.25 + H / 2), "#7a4a28")
    run = D / 2 + 0.35
    for s in (-1, 1):  # roof
        box((W + 0.5, run * 1.08, 0.14), (x, y + s * run / 2, 0.25 + H + run / 2 * 0.95), roof, rot=(s * -math.radians(43), 0, 0), bevel=0.03)
    ridge = (D / 2) * math.tan(math.radians(43))  # gable ends: a triangular prism under the roof
    z0, hw = 0.25 + H, W / 2 - 0.02
    verts = [(sx * hw, sy * (D / 2), z0) for sx in (-1, 1) for sy in (-1, 1)] + [(-hw, 0, z0 + ridge), (hw, 0, z0 + ridge)]
    faces = [(0, 1, 4), (2, 5, 3), (0, 2, 3, 1), (0, 4, 5, 2), (1, 3, 5, 4)]
    me = bpy.data.meshes.new("gable")
    me.from_pydata([(x + vx, y + vy, vz) for vx, vy, vz in verts], [], faces)
    me.update()
    g = bpy.data.objects.new("gable", me)
    bpy.context.collection.objects.link(g)
    bpy.context.view_layer.objects.active = g
    g.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT"); bpy.ops.mesh.normals_make_consistent(inside=False); bpy.ops.object.mode_set(mode="OBJECT")
    g.data.materials.append(mat("#d8a46a"))
    box((0.3, 0.3, 0.7), (x + 0.75, y + 0.3, 0.25 + H + 0.9), "#9a948a")  # chimney
    # door, round club sign, windows
    box((0.62, 0.06, 1.05), (x - 0.35, y - D / 2 - 0.03, 0.25 + 0.53), "#7a4428")
    ball(0.035, (x - 0.12, y - D / 2 - 0.08, 0.8), "#ffcf3a", seg=8)
    cyl(0.28, 0.05, (x - 0.35, y - D / 2 - 0.06, 1.62), "#f4e2b8", verts=20, rot=(math.pi / 2, 0, 0))
    cyl(0.2, 0.06, (x - 0.35, y - D / 2 - 0.07, 1.62), flag, verts=20, rot=(math.pi / 2, 0, 0))
    for wx in (0.65,):
        box((0.62, 0.06, 0.55), (x + wx, y - D / 2 - 0.03, 1.15), "#6a4426")
        box((0.48, 0.07, 0.42), (x + wx, y - D / 2 - 0.035, 1.15), "#ffe8a0").data.materials[0] = glow("#ffe2a0", 2.5)
        box((0.5, 0.25, 0.2), (x + wx, y - D / 2 - 0.15, 0.82), "#7a4428")  # flower box
        for k in range(4):
            ball(0.06, (x + wx - 0.18 + k * 0.12, y - D / 2 - 0.15, 0.95), ["#ff6ad5", "#ffd23a", "#5ab4ff", "#ffffff"][k], seg=8)
    # porch steps, bench and lantern
    box((1.0, 0.45, 0.12), (x - 0.35, y - D / 2 - 0.3, 0.06), "#a8a296")
    box((0.9, 0.3, 0.08), (x + 0.75, y - D / 2 - 0.45, 0.32), "#b0703e")
    for bx in (0.4, 1.1):
        box((0.06, 0.25, 0.3), (x + bx, y - D / 2 - 0.45, 0.15), "#7a4428", bevel=0)
    cyl(0.03, 0.5, (x - 0.85, y - D / 2 - 0.05, 1.45), "#2a2420", rot=(math.pi / 2, 0, 0))
    ball(0.09, (x - 0.85, y - D / 2 - 0.3, 1.32), "#ffe8b0", seg=10).data.materials[0] = glow("#ffd890", 6)
    # flag on the roof ridge
    cyl(0.025, 0.9, (x - W / 2 + 0.3, y, 0.25 + H + 1.25), "#3a3640", verts=6)
    box((0.5, 0.03, 0.32), (x - W / 2 + 0.56, y, 0.25 + H + 1.52), flag, bevel=0)


def plot_base(n=N):
    cyl(30, 0.2, (0, 0, -0.1), "#6ab048", verts=48)
    h = n / 2
    box((n + 0.2, n + 0.2, 0.12), (0, 0, -0.04), "#7a5232", bevel=0.05)
    def post(x, y):
        box((0.14, 0.14, 0.8), (x, y, 0.4), "#e0a060")
    for i in range(18):
        t = -(h + 0.3) + i * (n + 0.6) / 17
        for x, y in ((t, h + 0.3), (-(h + 0.3), t), (h + 0.3, t)):
            post(x, y)
        if abs(t) > 0.9:
            post(t, -(h + 0.3))
    for z in (0.32, 0.62):
        box((n + 0.6, 0.06, 0.09), (0, h + 0.3, z), "#b0703e", bevel=0)
        for s in (-1, 1):
            box((0.06, n + 0.6, 0.09), (s * (h + 0.3), 0, z), "#b0703e", bevel=0)
            box((h - 0.6, 0.06, 0.09), (s * (h / 2 + 0.6), -(h + 0.3), z), "#b0703e", bevel=0)
    cyl(0.06, 1.5, (1.4, -(h + 0.6), 0.75), "#7a4428")
    box((1.5, 0.1, 0.6), (1.4, -(h + 0.62), 1.35), "#b0703e")
    box((1.35, 0.03, 0.45), (1.4, -(h + 0.68), 1.35), "#e8c890", bevel=0)


def crops_west():
    # crops fill the west half: tile centres at -3.5 .. -0.5, rows -0.5 .. 3.5
    kinds = ["carrot", "carrot", "wheat", "wheat", "pumpkin"]
    for r, kind in enumerate(kinds):
        y = 3.5 - r
        for c in range(4):
            if kind == "pumpkin" and c % 2:
                continue
            CROPS[kind](-3.5 + c, y, (3, 3, 2, 1)[c] if r < 4 else 3)


def hero(loc, rot):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(HERO))
    root = next(o for o in bpy.data.objects if o not in before and o.parent is None)
    root.location = loc
    root.rotation_euler = (0, 0, rot)
    root.scale = (1.1, 1.1, 1.1)


def plot_scene(build_mode=False):
    plot_base()
    crops_west()
    clubhouse(2.5, 2.5)  # north-east corner, 3 x 3 tiles
    if build_mode:
        for i in range(N + 1):  # tile grid on the soil
            box((N, 0.025, 0.012), (0, -N / 2 + i, 0.03), "#f4e2b8", bevel=0)
            box((0.025, N, 0.012), (-N / 2 + i, 0, 0.03), "#f4e2b8", bevel=0)
        box((2, 2, 0.02), (2, -2, 0.035), "#7aff6a", bevel=0).data.materials[0] = mat("#7aff6a", 1.5)
        altar(2, -2, ghost=ghost_mat())
    else:
        altar(2, -2)
    hero((0.2, -4.9, 0), 0.15)


def items_scene():
    cyl(30, 0.2, (0, 0, -0.1), "#6ab048", verts=48)
    altar(-2.0, 0)
    clubhouse(1.9, 0.3)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn, cam, target, lens in (
        ("build_items.png", items_scene, (0.2, -9.5, 4.6), (0, 0.4, 0.9), 32),
        ("build_plot.png", plot_scene, (1.6, -12.5, 7.6), (0, 0.4, 0.4), 30),
        ("build_mode.png", lambda: plot_scene(True), (1.6, -12.5, 7.6), (0, 0.4, 0.4), 30),
    ):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        MATS.clear()
        fn()
        render(name, cam, target, lens, (1280, 720))
    print("rendered to", OUT)
