"""Colosseum concept mockup (Blender, rendered stills only; not a game asset yet).

A real ring building rather than a flat frontage: four storeys of travertine, the
lower three an arcade of round-headed arches between engaged columns, the top an
attic wall with pilasters and the velarium masts. Inside, the pit and three tiers
of seating, with the two gates that lead to them. The ring is a circle of outer
radius ~21 tiles, matching the game's pit radius of 14.

    blender -b -P tools/blender/colosseum_mock.py -- <out_dir>

Writes colosseum_view.png (three-quarter, the way you meet it from the plaza),
colosseum_front.png (the entrance front on), colosseum_cut.png (half the ring
removed, so the seating reads) and colosseum_plan.png (top down).

One bay is built once per storey and then linked-duplicated around the ring, so
the arch voussoirs cost almost nothing however many bays there are.
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

OUT = Path(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else ".").resolve()
HERO = Path(__file__).resolve().parents[2] / "game/assets3d/hero_blender.glb"

R_PIT = 14.0          # the sand, same as the game
R_SEAT = 19.6         # back of the top seating tier
R_OUT = 21.0          # the outer face of the ring
BAYS = 40             # arches per storey
STOREY = 4.2          # floor to floor
GATE_BAYS = (0, 20)   # the two bays left open as entrances (south and north)


def hexc(h, a=1.0):
    h = h.lstrip("#")
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return [lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)] + [a]


MATS = {}


def mat(color, glow=0.0, rough=0.85):
    key = (color, glow)
    if key not in MATS:
        m = bpy.data.materials.new(f"{color}{glow}")
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = hexc(color)
        b.inputs["Roughness"].default_value = rough
        if glow:
            b.inputs["Emission Color"].default_value = hexc(color)
            b.inputs["Emission Strength"].default_value = glow
        MATS[key] = m
    return MATS[key]


def box(size, loc, color, rot=(0, 0, 0), glow=0.0, bevel=0.03):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    if bevel:
        m = o.modifiers.new("b", "BEVEL")
        m.width = bevel
        m.segments = 2
    o.data.materials.append(mat(color, glow))
    return o


def cyl(r, h, loc, color, verts=24, glow=0.0, r2=None, rot=(0, 0, 0)):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=loc, rotation=rot)
    o = bpy.context.object
    o.data.materials.append(mat(color, glow))
    return o


def join(objs, name):
    """Join a pile of primitives into one object whose origin is the world origin.

    The origin matters: join() otherwise leaves it at the first part's centre, and every
    copy placed around the ring then sits that far off the height it was asked for."""
    for o in bpy.data.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    return o


# ---------------------------------------------------------------- the arcade

TRAVERTINE = ("#c3b494", "#b6a788", "#a89a7c")
SHADOW = "#5f574a"


def make_bay(storey):
    """One bay, built flat: the wall runs along Y, its thickness along X, origin on
    the outer face at ground level for this storey. Duplicated round the ring."""
    bw = 2 * math.pi * R_OUT / BAYS          # bay width on the outer face
    pier = bw * 0.30
    opening = bw - pier
    spring = STOREY * 0.52                   # where the arch starts to turn
    rad = opening / 2
    depth = 1.5
    face = TRAVERTINE[storey % 3]
    parts = []

    # the wall behind the arcade, with the opening left out of it
    parts.append(box((depth * 0.55, pier, STOREY), (-depth * 0.28, (opening + pier) / 2, STOREY / 2), face))
    parts.append(box((depth * 0.55, pier, STOREY), (-depth * 0.28, -(opening + pier) / 2, STOREY / 2), face))
    # the pier itself, standing proud of the wall
    for sy in (-1, 1):
        parts.append(box((depth, pier, STOREY), (0, sy * (opening + pier) / 2, STOREY / 2), face))

    # the arch: voussoirs stepping round a half circle over the opening
    n = 13
    for i in range(n):
        a = math.pi * (i + 0.5) / n
        y, z = math.cos(a) * rad, spring + math.sin(a) * rad
        parts.append(box((depth * 0.92, bw * 0.085, 0.52), (0.02, y, z), face,
                         rot=(a, 0, 0), bevel=0.02))
    # the dark of the opening, set back so it reads as a hole in a thick wall
    parts.append(box((0.12, opening * 0.98, spring), (-depth * 0.42, 0, spring / 2), SHADOW, bevel=0))
    parts.append(cyl(rad * 0.98, 0.12, (-depth * 0.42, 0, spring), SHADOW, verts=24,
                     rot=(0, math.pi / 2, 0)))

    # engaged half-columns on the pier faces, with a capital and a base
    for sy in (-1, 1):
        cy = sy * (opening + pier) / 2
        parts.append(cyl(pier * 0.30, STOREY * 0.82, (depth * 0.5, cy, STOREY * 0.45), face, verts=16))
        parts.append(cyl(pier * 0.36, STOREY * 0.07, (depth * 0.5, cy, STOREY * 0.05), TRAVERTINE[2], verts=16))
        if storey == 2:  # a leafier capital up top, the way the orders change by storey
            parts.append(cyl(pier * 0.40, STOREY * 0.10, (depth * 0.5, cy, STOREY * 0.90), TRAVERTINE[0], verts=16, r2=pier * 0.30))
        else:
            parts.append(cyl(pier * 0.38, STOREY * 0.07, (depth * 0.5, cy, STOREY * 0.88), TRAVERTINE[0], verts=16))

    # the cornice band that caps the storey
    parts.append(box((depth * 1.2, bw, STOREY * 0.085), (depth * 0.12, 0, STOREY - STOREY * 0.043), "#e4dbc6"))
    return join(parts, f"bay{storey}")


def make_gate():
    """The ground-storey bay where a gate goes: one tall opening, no arcade above it."""
    bw = 2 * math.pi * R_OUT / BAYS
    pier = bw * 0.30
    opening = bw - pier
    parts = []
    for sy in (-1, 1):
        parts.append(box((1.9, pier * 1.25, STOREY * 1.9), (0.1, sy * (opening + pier) / 2, STOREY * 0.95), TRAVERTINE[0]))
    n = 13
    rad = opening / 2
    for i in range(n):
        a = math.pi * (i + 0.5) / n
        y, z = math.cos(a) * rad, STOREY * 1.08 + math.sin(a) * rad
        parts.append(box((1.8, bw * 0.095, 0.6), (0.1, y, z), TRAVERTINE[0], rot=(a, 0, 0), bevel=0.02))
    parts.append(box((0.2, opening * 0.98, STOREY * 1.08), (-0.75, 0, STOREY * 0.54), SHADOW, bevel=0))
    parts.append(cyl(rad * 0.98, 0.18, (-0.75, 0, STOREY * 1.08), SHADOW, verts=24, rot=(0, math.pi / 2, 0)))
    parts.append(box((2.1, bw * 1.1, STOREY * 0.16), (0.1, 0, STOREY * 1.95), "#efe7d4"))
    return join(parts, "gatebay")


def place(base, i, z, radius=R_OUT, n=BAYS, extra_rot=0.0):
    a = 2 * math.pi * i / n
    o = base.copy()           # linked duplicate: shares the mesh, costs nothing
    o.data = base.data
    bpy.context.collection.objects.link(o)
    o.location = (math.cos(a) * radius, math.sin(a) * radius, z)
    o.rotation_euler = (0, 0, a + extra_rot)
    o.hide_render = False     # the template is hidden; its copies are not
    o.hide_viewport = False
    return o


def make_seat(tier):
    """One block of seating, duplicated round its tier. Rings of blocks, not solid
    drums: a stack of cylinders just hides the smaller ones inside the biggest."""
    rad, h = R_PIT + 2.4 + tier * 1.6, 2.6 + tier * 1.2
    seg = 2 * math.pi * rad / 72
    parts = [box((1.65, seg * 1.02, h), (0, 0, h / 2), TRAVERTINE[tier % 3], bevel=0.02),
             box((1.7, seg * 1.02, 0.12), (0, 0, h + 0.05), "#b3a994", bevel=0)]
    return join(parts, f"seat{tier}")


def build():
    # the ground it stands on
    cyl(R_OUT + 16, 0.4, (0, 0, -0.2), "#6a9a4a", verts=96)
    cyl(R_OUT + 2.4, 0.3, (0, 0, 0.05), "#b9b0a0", verts=96)   # the paved apron
    cyl(R_OUT + 1.2, 0.35, (0, 0, 0.12), "#c6bdac", verts=96)  # two steps up to the arcade
    cyl(R_OUT + 0.6, 0.4, (0, 0, 0.22), "#d2c9b7", verts=96)

    bays = [make_bay(0), make_bay(1), make_bay(2)]
    gate = make_gate()
    seats = [make_seat(0), make_seat(1), make_seat(2)]
    for b in bays + [gate] + seats:
        b.hide_render = True
        b.hide_viewport = True

    for i in range(BAYS):
        if i in GATE_BAYS:
            place(gate, i, 0.4)   # the gate is two storeys tall on its own
            place(bays[2], i, 0.4 + 2 * STOREY)  # the top storey carries straight over it
            continue
        for s in range(3):
            place(bays[s], i, 0.4 + s * STOREY)

    # attic: a plain wall with flat pilasters, then the cornice and the masts
    top = 0.4 + 3 * STOREY
    bw = 2 * math.pi * R_OUT / BAYS
    for i in range(BAYS):
        a = 2 * math.pi * i / BAYS
        x, y = math.cos(a) * R_OUT, math.sin(a) * R_OUT
        box((1.2, bw, STOREY * 0.78), (x - 0.1, y, top + STOREY * 0.39), TRAVERTINE[1], rot=(0, 0, a))
        box((1.45, bw * 0.2, STOREY * 0.78), (x, y, top + STOREY * 0.39), TRAVERTINE[0], rot=(0, 0, a))
        # a small square window in every other attic bay
        if i % 2 == 0:
            box((0.2, bw * 0.3, STOREY * 0.26), (x + 0.55, y, top + STOREY * 0.46), SHADOW, rot=(0, 0, a), bevel=0)
    for i in range(BAYS):  # the crowning cornice, as a ring of blocks rather than a lid
        a = 2 * math.pi * i / BAYS
        box((1.25, bw * 1.02, 0.42), (math.cos(a) * (R_OUT + 0.18), math.sin(a) * (R_OUT + 0.18), top + STOREY * 0.82),
            "#e4dbc6", rot=(0, 0, a))
    for i in range(0, BAYS, 2):  # the masts that carried the awning
        a = 2 * math.pi * i / BAYS
        x, y = math.cos(a) * (R_OUT - 0.2), math.sin(a) * (R_OUT - 0.2)
        cyl(0.14, 3.0, (x, y, top + STOREY * 0.82 + 1.5), "#8a6a3a", verts=8)
        box((0.1, 0.55, 0.55), (x, y, top + STOREY * 0.82 + 3.1), "#c8383a", rot=(0, 0, a), bevel=0)

    # inside: the sand, the painted emblem and three tiers of seating
    # the sand sits proud of the apron steps outside, or they bury it
    cyl(R_PIT, 0.7, (0, 0, 0.22), "#d8b878", verts=96)
    for rr, c in ((3.2, "#c09a5e"), (2.9, "#d8b878"), (1.2, "#a83c2a"), (0.95, "#d8b878")):
        cyl(rr, 0.74, (0, 0, 0.23 + rr * 0.0008), c, verts=64)
    # the podium wall, as a ring of blocks so it does not read as a solid drum
    seg = 2 * math.pi * (R_PIT + 0.9) / 96
    pod = join([box((1.0, seg * 1.03, 2.5), (0, 0, 1.25), "#cfc3a6", bevel=0.02),
                box((1.06, seg * 1.03, 0.5), (0, 0, 1.75), "#a8302c", bevel=0),
                box((1.12, seg * 1.03, 0.26), (0, 0, 2.38), "#e4dbc6", bevel=0)], "podium")
    pod.hide_render = pod.hide_viewport = True
    for i in range(96):
        place(pod, i, 0.0, radius=R_PIT + 0.9, n=96)
    for t in range(3):
        for i in range(72):
            place(seats[t], i, 0.0, radius=R_PIT + 2.4 + t * 1.6, n=72)

    # banners over the two gates, red for the sand and blue for the seats
    for i, color in zip(GATE_BAYS, ("#a8302c", "#3a5ad8")):
        a = 2 * math.pi * i / BAYS
        x, y = math.cos(a) * (R_OUT + 0.55), math.sin(a) * (R_OUT + 0.55)
        box((0.12, 2.6, 1.5), (x, y, 0.4 + STOREY * 1.42), color, rot=(0, 0, a), bevel=0)
        box((0.14, 0.6, 0.6), (x, y, 0.4 + STOREY * 1.42), "#e0b450", rot=(0, 0, a), bevel=0)

    # a hero at the gate, for scale
    if HERO.exists():
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(HERO))
        new = [o for o in bpy.data.objects if o not in before]
        root = next(o for o in new if o.parent is None)
        root.location = (math.cos(0) * (R_OUT + 3.4), 0.0, 0.4)
        root.rotation_euler = (0, 0, math.pi)
        root.scale = (1.2, 1.2, 1.2)


def camera_and_light():
    scene = bpy.context.scene
    scene.frame_set(40)
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x, scene.render.resolution_y = 1400, 800
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = hexc("#9cc8f0")
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.55
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(52), math.radians(6), math.radians(-40)))
    bpy.context.object.data.energy = 1.9
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    return scene, cam, cam_data


def aim(cam, loc, target):
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def render():
    scene, cam, cam_data = camera_and_light()
    OUT.mkdir(parents=True, exist_ok=True)

    cam_data.lens = 38
    aim(cam, (60, -66, 34), (0, 0, 7))
    scene.render.filepath = str(OUT / "colosseum_view.png")
    bpy.ops.render.render(write_still=True)

    cam_data.lens = 40
    aim(cam, (74, -8.0, 7.0), (0, 0, 7.5))
    scene.render.filepath = str(OUT / "colosseum_front.png")
    bpy.ops.render.render(write_still=True)

    # half the ring hidden, so the seating and the pit read
    for o in bpy.data.objects:
        if o.type == "MESH" and o.location.y < -2 and o.location.length > R_PIT + 2:
            o.hide_render = True
    cam_data.lens = 34
    aim(cam, (8, -62, 40), (0, 3, 3))
    scene.render.filepath = str(OUT / "colosseum_cut.png")
    bpy.ops.render.render(write_still=True)
    for o in bpy.data.objects:
        if o.type == "MESH" and o.name.startswith(("bay", "gatebay")) is False:
            o.hide_render = o.hide_viewport

    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2 * (R_OUT + 6)
    cam.location = (0, 0, 60)
    cam.rotation_euler = (0, 0, 0)
    scene.render.resolution_x = scene.render.resolution_y = 900
    scene.render.filepath = str(OUT / "colosseum_plan.png")
    bpy.ops.render.render(write_still=True)


bpy.ops.wm.read_factory_settings(use_empty=True)
build()
if "--measure" in sys.argv:
    import collections
    zs = collections.defaultdict(lambda: [1e9, -1e9])
    for o in bpy.data.objects:
        if o.type != "MESH" or o.hide_render:
            continue
        key = o.name.split(".")[0]
        for c in o.bound_box:
            z = (o.matrix_world @ Vector(c)).z
            zs[key][0] = min(zs[key][0], z)
            zs[key][1] = max(zs[key][1], z)
    for k, (lo, hi) in sorted(zs.items()):
        print(f"MEASURE {k:16s} {lo:7.2f} .. {hi:7.2f}")
    raise SystemExit
render()
print("rendered to", OUT)
