"""The deep Mine: concept mockup (Blender, rendered stills only; not a game asset yet).

The two giants that wait on the bottom level, and the ladders that join the levels, in the
cave's look: dark violet rock, warm torchlight, blue crystal glow. The rigged Blender hero
stands in for scale.

  - The Crystal Golem: a hulking stone body, glowing blue crystals growing from its shoulders
    and back, fists down by the floor. Slow and heavy.
  - The Spider Queen: a wide, low spider with a striped abdomen, a crown of glowing red eyes
    and eight arched legs. Fast.
  - Ladders, the way Pokemon caves do it: a hole in the floor with the top of a ladder sticking
    out goes down a level; a ladder up a rock face into a hole above goes up one.

    blender -b -P tools/blender/mine_mock.py -- <out_dir>

Writes mine_giants.png (both giants and the hero), mine_ladders.png (a ladder down and a ladder
up), mine_ladder_up.png (looking up the ladder into the ceiling opening) and mine_lair.png (the two
of them in their cavern).
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

OUT = Path(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else ".").resolve()
HERO = Path(__file__).resolve().parents[2] / "game/assets3d/hero_blender.glb"


def hexc(h, a=1.0):
    h = h.lstrip("#")
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return [lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)] + [a]


MATS = {}


def mat(color, glow=0.0, rough=0.8):
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


def box(size, loc, color, rot=(0, 0, 0), glow=0.0, bevel=0.06):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    if bevel:
        m = o.modifiers.new("b", "BEVEL")
        m.width = bevel
        m.segments = 3
    o.data.materials.append(mat(color, glow))
    return o


def ball(r, loc, color, scale=(1, 1, 1), glow=0.0):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=24, ring_count=14)
    o = bpy.context.object
    o.scale = scale
    bpy.ops.object.shade_smooth()
    o.data.materials.append(mat(color, glow))
    return o


def cone(r, h, loc, color, rot=(0, 0, 0), glow=0.0, verts=6, r2=0.0):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=loc, rotation=rot)
    o = bpy.context.object
    o.data.materials.append(mat(color, glow))
    return o


def limb(p1, p2, r, color, r2=None):
    """A tapered cylinder from p1 to p2: legs and arms."""
    a, b = Vector(p1), Vector(p2)
    d = b - a
    bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=r, radius2=r2 if r2 is not None else r * 0.8, depth=d.length, location=(a + b) / 2)
    o = bpy.context.object
    o.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    bpy.ops.object.shade_smooth()
    o.data.materials.append(mat(color))
    return o


def light(loc, color, energy, radius=0.3):
    bpy.ops.object.light_add(type="POINT", location=loc)
    o = bpy.context.object
    o.data.energy = energy
    o.data.color = hexc(color)[:3]
    o.data.shadow_soft_size = radius
    return o


ROCK = ("#2c2436", "#362c44", "#41364f")


# ------------------------------------------------------------------ the cave

def cavern(w=34, d=26):
    box((w, d, 0.4), (0, 0, -0.2), "#231c2c", bevel=0)  # floor
    for i in range(int(w)):  # loose floor stones
        x, y = (i * 7.31) % w - w / 2, (i * 3.17) % d - d / 2
        box((0.5 + (i % 3) * 0.2, 0.4 + (i % 2) * 0.3, 0.12), (x, y, 0.05), ROCK[i % 3], rot=(0, 0, i))
    # chunky rock walls on three sides
    for k in range(18):
        a = k / 17
        for side, (x, y, sx, sy) in enumerate(((-w / 2 + a * w, d / 2, 2.6, 2.2), (-w / 2, -d / 2 + a * d, 2.2, 2.6), (w / 2, -d / 2 + a * d, 2.2, 2.6))):
            h = 5 + ((k * 7 + side * 3) % 5) * 0.9
            box((sx + (k % 3) * 0.4, sy, h), (x, y, h / 2), ROCK[(k + side) % 3], rot=(0, 0, (k * 0.37) % 0.4))
    # crystal clusters and torches
    for x, y in ((-12, 9), (11, 10), (-14, -6), (14, -4)):
        for j in range(4):
            cone(0.25 + j * 0.06, 1.2 + j * 0.35, (x + j * 0.3 - 0.4, y + (j % 2) * 0.3, 0.5 + j * 0.15), "#5ab4ff", rot=(0.25 * (j - 1.5), 0.2 * (j % 2), 0), glow=1.6)
        light((x, y, 1.6), "#5ab4ff", 160, 1)
    for x, y in ((-6, 11.5), (6, 11.5), (-15.5, 2), (15.5, 2)):
        box((0.12, 0.12, 1.4), (x, y, 2.4), "#5a3a22", bevel=0)
        cone(0.18, 0.4, (x, y, 3.25), "#ff9a3a", glow=12, verts=8)
        light((x, y - 0.3, 3.4), "#ff9a50", 220, 0.4)


# ------------------------------------------------------------------ the giants

def crystal_golem(at, face=0.0):
    """Hulking stone, blue crystal growths, fists at the floor. About twice the hero's height."""
    x0, y0 = at
    stone, dark, crystal = "#5a5068", "#433b52", "#7ae0ff"
    parts = []
    parts.append(box((1.6, 1.2, 1.0), (x0, y0, 1.2), dark))                   # hips
    for s in (-1, 1):                                                         # legs
        parts.append(box((0.7, 0.8, 1.0), (x0 + s * 0.55, y0, 0.5), stone))
    parts.append(box((2.6, 1.7, 1.9), (x0, y0, 2.6), stone, rot=(0.12, 0, 0)))  # chest, leaning forward
    parts.append(box((0.9, 0.85, 0.7), (x0, y0 - 0.55, 3.55), dark))           # head, sunk between the shoulders
    for s in (-1, 1):
        parts.append(ball(0.09, (x0 + s * 0.2, y0 - 0.99, 3.6), crystal, glow=14))  # eyes
        parts.append(box((0.95, 0.95, 0.9), (x0 + s * 1.7, y0 - 0.05, 3.15), stone))  # shoulders
        parts.append(box((0.65, 0.7, 1.5), (x0 + s * 1.85, y0 - 0.15, 1.95), dark))   # upper arm
        parts.append(box((1.0, 1.05, 0.9), (x0 + s * 1.95, y0 - 0.25, 0.75), stone))  # fist, near the floor
        for j in range(3):                                                    # crystals on the shoulders
            parts.append(cone(0.22 - j * 0.03, 0.9 + j * 0.25, (x0 + s * (1.55 + j * 0.2), y0 + 0.1 * j, 3.75 + j * 0.15),
                              crystal, rot=(-0.3 + j * 0.2, s * (0.4 + j * 0.15), 0), glow=1.8))
    for j in range(5):                                                        # a ridge of crystals down the back
        parts.append(cone(0.28, 1.0 + (j % 2) * 0.5, (x0 - 0.6 + j * 0.3, y0 + 0.75, 3.1 + (j % 3) * 0.2), crystal,
                          rot=(0.6, (j - 2) * 0.2, 0), glow=1.8))
    for z, w in ((2.3, 1.2), (2.9, 0.8)):                                     # glowing cracks across the chest
        parts.append(box((w, 0.04, 0.05), (x0 - 0.2, y0 - 0.9, z), crystal, rot=(0, 0.3, 0), glow=8, bevel=0))
    light((x0, y0 - 1.6, 3.4), "#7ae0ff", 90, 1)
    for p in parts:
        p.rotation_euler.z += 0  # (kept for symmetry with the spider; the golem faces -y)
    return parts


def spider_queen(at):
    """Low and wide: a striped abdomen, a crown of glowing red eyes, eight arched legs."""
    x0, y0 = at
    body, dark, mark, eye = "#3a2a4a", "#24182e", "#c8383a", "#ff4a4a"
    ball(1.35, (x0, y0 + 1.1, 1.55), body, scale=(1.15, 1.35, 0.95))         # abdomen
    for k in range(3):                                                        # stripes across it
        ball(1.36, (x0, y0 + 1.1, 1.55), mark, scale=(1.16 - k * 0.002, 0.08, 0.96))
        bpy.context.object.location.y = y0 + 0.4 + k * 0.55
    ball(0.75, (x0, y0 - 0.45, 1.2), dark, scale=(1.1, 1.0, 0.8))             # thorax
    ball(0.5, (x0, y0 - 1.15, 1.25), body)                                    # head
    for i, (ex, ez, r) in enumerate(((-0.18, 1.45, 0.11), (0.18, 1.45, 0.11), (-0.34, 1.35, 0.07), (0.34, 1.35, 0.07),
                                     (-0.1, 1.6, 0.06), (0.1, 1.6, 0.06), (-0.42, 1.2, 0.05), (0.42, 1.2, 0.05))):
        ball(r, (x0 + ex, y0 - 1.55, ez), eye, glow=16)
    for s in (-1, 1):                                                         # fangs
        cone(0.07, 0.4, (x0 + s * 0.15, y0 - 1.55, 0.95), "#efe6d0", rot=(math.pi, 0, 0))
    for s in (-1, 1):
        for j in range(4):                                                    # legs: up to a knee, out and down to the floor
            hip = Vector((x0 + s * 0.6, y0 - 0.75 + j * 0.35, 1.25))
            knee = Vector((x0 + s * (2.1 + j * 0.15), y0 - 1.6 + j * 0.95, 2.45 - j * 0.1))
            foot = Vector((x0 + s * (3.1 + j * 0.2), y0 - 2.2 + j * 1.35, 0.05))
            limb(hip, knee, 0.16, dark, 0.13)
            limb(knee, foot, 0.13, body, 0.05)
    light((x0, y0 - 2.4, 1.8), "#ff4a4a", 50, 0.5)


def hero(at, face):
    if not HERO.exists():
        return
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(HERO))
    new = [o for o in bpy.data.objects if o not in before]
    root = next(o for o in new if o.parent is None)
    root.location = (at[0], at[1], 0)
    root.rotation_euler = (0, 0, face)
    root.scale = (1.2, 1.2, 1.2)


# ------------------------------------------------------------------ ladders

def ladder_down(at):
    """A hole in the floor with a wooden frame and the top of a ladder sticking up out of it."""
    x0, y0 = at
    box((1.5, 1.5, 0.5), (x0, y0, -0.27), "#000000", bevel=0)  # the dark of the hole, below the floor
    for dx, dy, sx, sy in ((0, 0.85, 1.9, 0.25), (0, -0.85, 1.9, 0.25), (0.85, 0, 0.25, 1.45), (-0.85, 0, 0.25, 1.45)):
        box((sx, sy, 0.2), (x0 + dx, y0 + dy, 0.1), "#6b4426")
    for s in (-1, 1):
        box((0.1, 0.1, 1.3), (x0 + s * 0.42, y0 + 0.55, 0.15), "#8a5a30", rot=(0.25, 0, 0))
    for k in range(3):
        box((0.85, 0.08, 0.08), (x0, y0 + 0.6 - k * 0.04, 0.55 - k * 0.32), "#a06e46", bevel=0.02)
    light((x0, y0 - 1.2, 1.4), "#ffd27a", 30, 0.2)


def ladder_up(at, ceiling=4.6):
    """The floor hole turned upside down: a slab of rock ceiling overhead with an open square cut
    through it, framed in timber, and a ladder standing straight up from the floor through the
    opening. Light from the floor above falls down through it."""
    x0, y0 = at
    hole, slab, thick = 1.5, 16.0, 0.9  # a wide slab, so its edges stay out of shot
    zb = ceiling                     # underside of the ceiling
    zc = zb + thick / 2
    # the ceiling slab, as four blocks around the opening (so the opening is a real gap)
    side = (slab - hole) / 2
    for dx, dy, sx, sy in ((0, (hole + side) / 2, slab, side), (0, -(hole + side) / 2, slab, side),
                           ((hole + side) / 2, 0, side, hole), (-(hole + side) / 2, 0, side, hole)):
        box((sx, sy, thick), (x0 + dx, y0 + dy, zc), ROCK[1], bevel=0.12)
    # a rough, uneven underside, like the cave walls
    for k in range(10):
        a = k * 0.63
        r = hole / 2 + 2.0 + (k % 3) * 0.7
        box((1.1, 1.0, 0.5 + (k % 2) * 0.3), (x0 + math.cos(a) * r, y0 + math.sin(a) * r, zb - 0.15), ROCK[k % 3], rot=(0, 0, a))
    # the timber frame around the opening, on the underside, like the floor hole's
    for dx, dy, sx, sy in ((0, hole / 2 + 0.1, hole + 0.4, 0.25), (0, -hole / 2 - 0.1, hole + 0.4, 0.25),
                           (hole / 2 + 0.1, 0, 0.25, hole), (-hole / 2 - 0.1, 0, 0.25, hole)):
        box((sx, sy, 0.22), (x0 + dx, y0 + dy, zb - 0.05), "#6b4426")
    for sx in (-1, 1):  # two short posts holding the frame up, as in a mine shaft
        for sy in (-1, 1):
            box((0.16, 0.16, 0.7), (x0 + sx * (hole / 2 + 0.1), y0 + sy * (hole / 2 + 0.1), zb - 0.4), "#5a3a22", bevel=0.02)
    # the ladder: straight up from the floor, through the opening, and out the top
    top = zb + thick + 0.9
    for sxs in (-1, 1):
        box((0.11, 0.11, top), (x0 + sxs * 0.42, y0 + 0.35, top / 2), "#8a5a30")
    for k in range(int(top / 0.45)):
        box((0.85, 0.08, 0.08), (x0, y0 + 0.35, 0.35 + k * 0.45), "#a06e46", bevel=0.02)
    # through the opening: the lit floor of the level above, so it reads as a way up
    box((hole + 0.6, hole + 0.6, 0.1), (x0, y0, zb + thick + 0.9), "#ffe2a8", glow=2.2, bevel=0)
    for dx, dy, sx, sy in ((0, hole / 2 + 0.05, hole, 0.1), (0, -hole / 2 - 0.05, hole, 0.1),
                           (hole / 2 + 0.05, 0, 0.1, hole), (-hole / 2 - 0.05, 0, 0.1, hole)):
        box((sx, sy, thick + 0.9), (x0 + dx, y0 + dy, zb + (thick + 0.9) / 2), "#3a2a20", bevel=0)  # the shaft walls
    # daylight-ish light from the floor above, falling down the shaft
    light((x0, y0, zb + thick + 0.6), "#ffe0a0", 140, 0.6)
    bpy.ops.object.light_add(type="SPOT", location=(x0, y0, zb + thick + 1.2))
    sp = bpy.context.object
    sp.data.energy = 600
    sp.data.color = hexc("#ffe0a0")[:3]
    sp.data.spot_size = math.radians(38)
    sp.data.spot_blend = 0.6


# ------------------------------------------------------------------ render

def camera_and_world():
    scene = bpy.context.scene
    scene.frame_set(40)
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x, scene.render.resolution_y = 1400, 820
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = hexc("#0d0a14")
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(60), 0, math.radians(-30)))
    bpy.context.object.data.energy = 1.1
    bpy.context.object.data.color = hexc("#9a8ad8")[:3]  # a cold fill, so the dark is violet not black
    light((0, -4, 7), "#c8b8ff", 600, 3)  # a soft light over the middle of the cavern
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    return scene, cam, cam_data


def aim(cam, loc, target):
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def render():
    scene, cam, cam_data = camera_and_world()
    OUT.mkdir(parents=True, exist_ok=True)

    cam_data.lens = 30
    aim(cam, (0.5, -15, 6.5), (0, 1.5, 1.8))
    scene.render.filepath = str(OUT / "mine_giants.png")
    bpy.ops.render.render(write_still=True)

    cam_data.lens = 34
    aim(cam, (-3.6, -9.6, 2.9), (-10.2, 0.6, 2.4))
    scene.render.filepath = str(OUT / "mine_ladders.png")
    bpy.ops.render.render(write_still=True)

    # standing at the foot of the ladder up, looking up it into the opening
    cam_data.lens = 22
    aim(cam, (-7.4, -1.4, 1.3), (-9.0, 2.6, 5.6))
    scene.render.filepath = str(OUT / "mine_ladder_up.png")
    bpy.ops.render.render(write_still=True)

    cam_data.lens = 22
    aim(cam, (11, -11, 11), (0, 2, 0.5))
    scene.render.filepath = str(OUT / "mine_lair.png")
    bpy.ops.render.render(write_still=True)


bpy.ops.wm.read_factory_settings(use_empty=True)
cavern()
crystal_golem((-4.2, 2.5))
spider_queen((4.2, 2.0))
hero((0, -5.5), math.pi)
ladder_down((-11.5, -2.5))
ladder_up((-9.0, 2.5))
render()
print("rendered to", OUT)
