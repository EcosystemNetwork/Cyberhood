"""Build the modular gothic armour kit and export one GLB with a node per piece.

    blender -b --python tools/blender/armor_kit.py -- <out.glb>
    npx @gltf-transform/cli optimize <out.glb> game/showcase/assets/armor_kit.glb --compress meshopt \
        --simplify false --join false --flatten false     # keep one node per piece: the game finds them by name

Every piece is a rigid plate set with its origin at the socket it hangs from
(game/showcase/armor.js → SOCKETS). Geometry is written in three.js axes (V(): +y up, +z the
hero's front, +x the hero's left) and converted to Blender's on the way in, so the numbers below
read the same as the game code. Sized for the 1.55 m hero (measured bone positions in idle):
shoulder half-width ~0.15, upper arm 0.19, forearm 0.18, shin 0.35, neck base at 1.26.

  gorget        Neck         two-lame collar flaring over the shoulders
  pauldron_L/R  Left/RightArm  domed cop with three lames down the arm
  breastplate   Spine2       ridged breastplate with two fauld lames
  vambrace_L/R  Left/RightForeArm   couter + forearm tube (axis +y = toward the hand)
  greave_L/R    Left/RightLeg  poleyn + shin plate (axis +y = toward the foot)
  helm          Head         sallet-style skull with brow band and nasal

Plates: blackened steel; rolled edges and rivets: aged brass; straps: leather. Factor-only PBR
(the sky does the work, as with the longsword). Plates are surfaces given thickness by Solidify.
"""
import bpy, bmesh, math, sys
from mathutils import Vector

out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else '/tmp/armor_kit.glb'
bpy.ops.wm.read_factory_settings(use_empty=True)
TAU = math.tau


def V(x, y, z):  # three.js axes → Blender axes (glTF export maps them back)
    return Vector((x, -z, y))


def lin(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def material(name, color, metal, rough):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*lin(color), 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    return m


STEEL = material('armor_steel', '#4c4e53', 1.0, 0.4)
BRASS = material('armor_brass', '#a3804a', 1.0, 0.33)
LEATHER = material('armor_leather', '#2c1d14', 0.0, 0.66)


def grid(fn, nu, nv, closed_u=False):
    """Surface from fn(u, v) -> (x, y, z) in three axes, u, v in [0, 1]."""
    bm = bmesh.new()
    cols = nu if closed_u else nu + 1
    vs = [[bm.verts.new(V(*fn(i / nu, j / nv))) for j in range(nv + 1)] for i in range(cols)]
    for i in range(nu):
        a, b = vs[i], vs[(i + 1) % cols]
        for j in range(nv):
            bm.faces.new((a[j], b[j], b[j + 1], a[j + 1]))
    return bm


def tube(path, r, segs=8):
    """A rolled edge: a small round tube along a list of three-axes points."""
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(path):
        p = Vector(p)
        t = (Vector(path[min(i + 1, len(path) - 1)]) - Vector(path[max(i - 1, 0)])).normalized()
        n = t.orthogonal().normalized()
        b = t.cross(n)
        rings.append([bm.verts.new(V(*(p + (n * math.cos(k / segs * TAU) + b * math.sin(k / segs * TAU)) * r))) for k in range(segs)])
    for a, b in zip(rings, rings[1:]):
        for k in range(segs):
            bm.faces.new((a[k], a[(k + 1) % segs], b[(k + 1) % segs], b[k]))
    return bm


def rivet(p, r=0.0055):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=5, radius=r)
    bmesh.ops.translate(bm, vec=V(*p), verts=bm.verts)
    return bm


def put(parts, name):
    """parts: [(bmesh, material, thickness or 0)] → one object named `name`, origin at 0."""
    objs = []
    for bm, mat, thick in parts:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for p in me.polygons:
            p.use_smooth = True
        me.set_sharp_from_angle(angle=math.radians(50))
        o = bpy.data.objects.new(name, me)
        o.data.materials.append(mat)
        bpy.context.collection.objects.link(o)
        if thick:
            m = o.modifiers.new('solid', 'SOLIDIFY')
            m.thickness = thick
            m.offset = 1
            m.use_even_offset = True
        objs.append(o)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        for m in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    return o


def mirror(src, name):
    o = src.copy()
    o.data = src.data.copy()
    o.name = name
    bpy.context.collection.objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for v in bm.verts:
        v.co.x = -v.co.x
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    return o


def ring_pts(cx, cy, cz, r, a0, a1, n=24, fy=lambda a: 0, axis='y'):
    pts = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        if axis == 'y':
            pts.append((cx + math.cos(a) * r, cy + fy(a), cz + math.sin(a) * r))
    return pts


# ---------------------------------------------------------------- gorget (Neck)
def gorget():
    parts = []
    for k, (y0, y1, r0, r1) in enumerate([(0.035, -0.012, 0.062, 0.088), (-0.004, -0.05, 0.084, 0.122)]):
        dip = lambda a: -0.022 * max(0, math.sin(a))  # lower at the front (+z = sin a > 0)
        fn = lambda u, v, y0=y0, y1=y1, r0=r0, r1=r1: (
            math.cos(u * TAU) * (r0 + (r1 - r0) * v) * 1.08, y0 + (y1 - y0) * v + dip(u * TAU), math.sin(u * TAU) * (r0 + (r1 - r0) * v) * 0.92)
        parts.append((grid(fn, 40, 3, closed_u=True), STEEL, 0.003))
    edge = [(math.cos(a) * 0.122 * 1.08, -0.05 - 0.022 * max(0, math.sin(a)), math.sin(a) * 0.122 * 0.92) for a in [i / 48 * TAU for i in range(49)]]
    parts.append((tube(edge, 0.0045), BRASS, 0))
    for a in (0.5, 1.2, 1.95, 2.65):
        parts.append((rivet((math.cos(a) * 0.1, -0.03 - 0.02 * math.sin(a), math.sin(a) * 0.087)), BRASS, 0))
    return put(parts, 'gorget')


# ---------------------------------------------------------------- pauldron (LeftArm; +x = outward)
def pauldron():
    parts = []
    # domed cop over the shoulder ball, tilted outward
    tilt = math.radians(28)
    def cop(u, v):
        th, ph = v * math.radians(78), u * TAU
        x, y, z = math.sin(th) * math.cos(ph) * 0.088, math.cos(th) * 0.07, math.sin(th) * math.sin(ph) * 0.082
        # tilt about z (toward +x), then lift
        x, y = x * math.cos(tilt) + y * math.sin(tilt), -x * math.sin(tilt) + y * math.cos(tilt)
        return (x + 0.012, y - 0.005, z)
    parts.append((grid(cop, 36, 8, closed_u=True), STEEL, 0.0035))
    # a medial ridge over the cop
    parts.append((tube([cop(0.0, i / 10) for i in range(10)], 0.003), STEEL, 0))
    # three lames down the outside of the arm (arc centred on +x), each overlapping the next
    for k in range(3):
        y0 = -0.035 - k * 0.03
        a0, a1 = -2.0, 2.0
        fn = lambda u, v, y0=y0, k=k: (
            math.cos(a0 + (a1 - a0) * u) * (0.074 - k * 0.004 + 0.006 * v) + 0.012, y0 - 0.036 * v, math.sin(a0 + (a1 - a0) * u) * (0.07 - k * 0.004 + 0.006 * v))
        parts.append((grid(fn, 22, 2), STEEL, 0.003))
        if k == 2:
            parts.append((tube([fn(i / 22, 1.0) for i in range(23)], 0.004), BRASS, 0))
        parts.append((rivet(fn(0.5, 0.35)), BRASS, 0))
    rim = [cop(i / 40, 1.0) for i in range(41)]
    parts.append((tube(rim, 0.0042), BRASS, 0))
    return put(parts, 'pauldron_L')


# ---------------------------------------------------------------- breastplate (Spine2)
def breastplate():
    parts = []
    def shell(u, v):  # u: -1 … 1 across, v: 0 bottom … 1 top (neckline)
        x = u * (0.15 - 0.035 * v * v)
        top = 0.135 - 0.05 * (1 - u * u)
        y = -0.15 + (top + 0.15) * v
        z = 0.045 + 0.085 * math.sqrt(max(0.0, 1 - 0.82 * u * u)) * (1 - 0.3 * (v - 0.55) ** 2) - 0.05 * u ** 4
        z += 0.007 * max(0.0, 1 - abs(u) * 7)  # medial ridge
        return (x, y, z)
    parts.append((grid(lambda a, b: shell(a * 2 - 1, b), 32, 14), STEEL, 0.004))
    neck = [shell(i / 20 * 2 - 1, 1.0) for i in range(21)]
    parts.append((tube(neck, 0.0055), BRASS, 0))
    for side in (-1, 1):  # arm openings get a rolled edge too
        parts.append((tube([shell(side, j / 12) for j in range(4, 13)], 0.0045), BRASS, 0))
    # two fauld lames below
    for k in range(2):
        y0 = -0.145 - k * 0.04
        fn = lambda u, v, y0=y0, k=k: (
            (u * 2 - 1) * (0.155 + 0.01 * k + 0.008 * v), y0 - 0.045 * v,
            0.05 + 0.075 * math.sqrt(max(0.0, 1 - 0.82 * (u * 2 - 1) ** 2)) + 0.006 * v - 0.05 * (u * 2 - 1) ** 4 + 0.008 * k)
        parts.append((grid(fn, 26, 2), STEEL, 0.003))
        if k == 1:
            parts.append((tube([fn(i / 26, 1.0) for i in range(27)], 0.004), BRASS, 0))
        for u in (0.15, 0.85):
            parts.append((rivet(fn(u, 0.3)), BRASS, 0))
    # straps over the shoulders, back toward the spine
    for side in (-1, 1):
        x = side * 0.1
        path = [(x, 0.105, 0.06), (x * 1.05, 0.14, 0.0), (x * 1.08, 0.12, -0.07)]
        bm = tube(path, 0.006, 6)
        parts.append((bm, LEATHER, 0))
    return put(parts, 'breastplate')


# ---------------------------------------------------------------- vambrace (LeftForeArm; +y toward the hand)
def vambrace():
    parts = []
    # couter: a cop on the point of the elbow (behind: -z), with a fan on the outside (+x)
    def cop(u, v):
        th, ph = v * math.radians(70), u * TAU
        return (math.sin(th) * math.cos(ph) * 0.036, math.sin(th) * math.sin(ph) * 0.036, -0.012 - math.cos(th) * 0.034)
    parts.append((grid(cop, 24, 6, closed_u=True), STEEL, 0.003))
    parts.append((tube([cop(i / 24, 1.0) for i in range(25)], 0.0035), BRASS, 0))
    fan = lambda u, v: (0.03 + 0.03 * v * math.cos((u - 0.5) * 2.2), (u - 0.5) * 0.07 * (1 - 0.4 * v), -0.03 + 0.03 * v * math.sin((u - 0.5) * 2.2) * 0.2)
    parts.append((grid(fan, 10, 3), STEEL, 0.0025))
    # the tube, opening on the inside (-x) so the forearm can twist
    a0, a1 = -math.pi + 0.55, math.pi - 0.55
    fn = lambda u, v: (math.cos(a0 + (a1 - a0) * u) * (0.041 - 0.007 * v), 0.03 + 0.13 * v, math.sin(a0 + (a1 - a0) * u) * (0.038 - 0.006 * v))
    parts.append((grid(fn, 20, 6), STEEL, 0.003))
    for v in (0.0, 1.0):
        parts.append((tube([fn(i / 20, v) for i in range(21)], 0.0035), BRASS, 0))
    for u in (0.3, 0.7):
        parts.append((rivet(fn(u, 0.5)), BRASS, 0.0))
    return put(parts, 'vambrace_L')


# ---------------------------------------------------------------- greave (LeftLeg; +y toward the foot)
def greave():
    parts = []
    # poleyn: a cop on the front of the knee
    def cop(u, v):
        th, ph = v * math.radians(72), u * TAU
        return (math.sin(th) * math.cos(ph) * 0.05, math.sin(th) * math.sin(ph) * 0.052, 0.03 + math.cos(th) * 0.04)
    parts.append((grid(cop, 24, 6, closed_u=True), STEEL, 0.0035))
    parts.append((tube([cop(i / 24, 1.0) for i in range(25)], 0.004), BRASS, 0))
    wing = lambda u, v: (0.048 + 0.012 * v, (u - 0.5) * 0.075, 0.03 - 0.035 * v)
    parts.append((grid(wing, 8, 2), STEEL, 0.003))
    # shin plate: the front 200°, ridged down the middle
    a0, a1 = math.radians(-10), math.radians(190)
    def shin(u, v):
        a = a0 + (a1 - a0) * u
        r = 0.052 - 0.012 * v + 0.004 * max(0.0, 1 - abs(a - math.pi / 2) * 4)
        return (math.cos(a) * r, 0.06 + 0.2 * v, math.sin(a) * r * 1.05)
    parts.append((grid(shin, 22, 8), STEEL, 0.003))
    for v in (0.0, 1.0):
        parts.append((tube([shin(i / 22, v) for i in range(23)], 0.004), BRASS, 0))
    for v in (0.25, 0.75):  # straps round the calf
        a = [(math.cos(t) * (0.05 - 0.012 * v), 0.06 + 0.2 * v, math.sin(t) * (0.05 - 0.012 * v)) for t in [math.radians(185 + i * 9) for i in range(21)]]
        parts.append((tube(a, 0.005, 6), LEATHER, 0))
    return put(parts, 'greave_L')


# ---------------------------------------------------------------- helm (Head)
# a close bascinet: round skull a little longer front to back, lower at the back of the neck,
# with a brow band and a nasal lying on the face
def helm():
    parts = []
    R, CY, CZ = 0.098, 0.07, 0.006
    def skull(u, v):  # v: 0 rim … 1 crown
        ph = u * TAU
        th = (1 - v) * math.radians(96)
        front = max(0.0, math.sin(ph))
        th *= 1 - 0.2 * front  # the rim rides higher over the brow
        x, y, z = math.sin(th) * math.cos(ph) * R * 0.95, math.cos(th) * R, math.sin(th) * math.sin(ph) * R * 1.06
        return (x, y + CY + 0.01 * v * v, z + CZ)
    parts.append((grid(skull, 40, 12, closed_u=True), STEEL, 0.003))
    parts.append((tube([skull(i / 48, 0.0) for i in range(49)], 0.0045), BRASS, 0))
    parts.append((tube([skull(0.25, j / 12) for j in range(13)] + [skull(0.75, 1 - j / 12) for j in range(1, 13)], 0.0032), BRASS, 0))  # crest, brow to nape
    top = skull(0.25, 0.0)
    nas = lambda u, v: ((u - 0.5) * 0.022 * (1 - 0.35 * v), top[1] + 0.004 - 0.06 * v, top[2] - 0.004 - 0.012 * v * v)
    parts.append((grid(nas, 2, 4), STEEL, 0.003))
    for a in (0.1, 0.4, 0.6, 0.9):
        parts.append((rivet(skull(a, 0.1)), BRASS, 0))
    return put(parts, 'helm')


gorget()
pl = pauldron(); mirror(pl, 'pauldron_R')
breastplate()
vb = vambrace(); mirror(vb, 'vambrace_R')
gr = greave(); mirror(gr, 'greave_R')
helm()

tris = 0
for o in bpy.data.objects:
    t = sum(len(p.vertices) - 2 for p in o.data.polygons)
    tris += t
    print(f'  {o.name:12s} {t:6d} tris')
print(f'armor kit: {len(bpy.data.objects)} pieces, {tris} tris')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True, export_yup=True)
print('wrote', out)
