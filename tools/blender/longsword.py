"""Build the showcase longsword and export it as a glTF binary.

    blender -b --python tools/blender/longsword.py -- game/showcase/assets/longsword_raw.glb
    npx @gltf-transform/cli optimize <raw> game/showcase/assets/longsword.glb --compress meshopt

Conventions (match game/lib/hero3d.js WEAPONS so glbhero's hold / carry / trail / sheath work):
  grip centre at the origin, blade along +Z here (= +Y in three.js), edges along X, flats facing Y.
  Sized for the 1.55 m hero: ~0.92 m overall, a hand-and-a-half sword.
Materials are pure PBR factors (no textures): the sky's reflections do the work on metal.
Hard edges are split with sharp-by-angle so the diamond section and fuller read crisply.
"""
import bpy, bmesh, math, sys
from mathutils import Vector

out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else '/tmp/longsword.glb'

bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, metal, rough):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    return m


def lin(h):  # sRGB hex → linear
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


STEEL = material('steel', lin('#c8ccd2'), 1.0, 0.24)
IRON = material('blackened_iron', lin('#3c3a3c'), 1.0, 0.42)
BRASS = material('aged_brass', lin('#a98446'), 1.0, 0.34)
LEATHER = material('leather_wrap', lin('#3a2418'), 0.0, 0.62)


def obj(name, bm, mat, sharp=35):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(sharp))
    o = bpy.data.objects.new(name, me)
    o.data.materials.append(mat)
    bpy.context.collection.objects.link(o)
    return o


def loft(rings, cap0=True, cap1=True):
    """Rings of equal length (closed loops of Vectors) → a skinned tube."""
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    for a, b in zip(vs, vs[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap0:
        bm.faces.new(list(reversed(vs[0])))
    if cap1:
        bm.faces.new(vs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


# ---- blade: diamond section with a fuller down the lower two-thirds, tapering to a point
B0, B1 = 0.095, 0.835          # blade base / tip (z)
W0, T0 = 0.026, 0.0062         # half-width / half-thickness at the base


def section(z):
    s = (z - B0) / (B1 - B0)
    w = W0 * (1 - 0.32 * s)                                   # gentle profile taper
    if s > 0.8:
        w *= math.cos((s - 0.8) / 0.2 * math.pi / 2) ** 0.75  # ogive point
    t = T0 * (1 - 0.45 * s)
    full = max(0.0, 1 - s / 0.68) ** 0.35 if s < 0.68 else 0  # fuller depth, fading out
    full *= min(1, (z - B0) / 0.02)                           # runs out just above the ricasso
    f = t * (1 - 0.55 * full)                                  # groove floor
    pts = [(w, 0), (w * 0.62, t * 0.62), (w * 0.3, t), (w * 0.17, f), (0, f), (-w * 0.17, f), (-w * 0.3, t), (-w * 0.62, t * 0.62),
           (-w, 0), (-w * 0.62, -t * 0.62), (-w * 0.3, -t), (-w * 0.17, -f), (0, -f), (w * 0.17, -f), (w * 0.3, -t), (w * 0.62, -t * 0.62)]
    return [Vector((x, y, z)) for x, y in pts]


N = 40
zs = [B0 + (B1 - B0) * (i / N) ** 0.9 for i in range(N)]
rings = [section(z) for z in zs]
blade = loft(rings, cap0=True, cap1=False)
tip = blade.verts.new((0, 0, B1))
last = [v for v in blade.verts if abs(v.co.z - zs[-1]) < 1e-6]
# close the point: fan the last ring to the tip
lastring = sorted(last, key=lambda v: math.atan2(v.co.y, v.co.x))
for i in range(len(lastring)):
    a, b = lastring[i], lastring[(i + 1) % len(lastring)]
    blade.faces.new((a, b, tip))
bmesh.ops.recalc_face_normals(blade, faces=blade.faces)
obj('blade', blade, STEEL, sharp=28)

# ---- ricasso collar (blackened) where blade meets guard
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1)
bmesh.ops.scale(bm, vec=(0.062, 0.02, 0.022), verts=bm.verts)
bmesh.ops.translate(bm, vec=(0, 0, 0.085), verts=bm.verts)
bmesh.ops.bevel(bm, geom=bm.edges[:], offset=0.003, segments=2, affect='EDGES')
obj('collar', bm, IRON)

# ---- crossguard: a square bar swept along a downturned curve, flaring into knobbed ends
rings = []
M = 36
for i in range(M + 1):
    u = i / M * 2 - 1                    # -1 … 1 along the guard
    x = u * 0.105
    z = 0.072 + 0.016 * u * u            # quillons sweep toward the blade (gothic)
    r = 0.0085 * (1 - 0.25 * abs(u)) + 0.006 * max(0, abs(u) - 0.85) / 0.15
    d = Vector((0.105, 0, 0.032 * u)).normalized()  # tangent of the sweep
    nz = Vector((-d.z, 0, d.x))                     # in-plane normal
    ring = []
    for k in range(8):
        a = k / 8 * math.tau + math.pi / 8
        ring.append(Vector((x, 0, z)) + nz * math.cos(a) * r + Vector((0, 1, 0)) * math.sin(a) * r * 1.25)
    rings.append(ring)
obj('guard', loft(rings), IRON, sharp=50)
for sx in (-1, 1):  # finials
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.0125)
    bmesh.ops.translate(bm, vec=(sx * 0.108, 0, 0.0885), verts=bm.verts)
    obj('finial', bm, BRASS, sharp=80)

# ---- grip: leather over a swelling core, with raised wrap ridges and a brass ferrule each end
G0, G1 = -0.085, 0.062
rings = []
for i in range(61):
    z = G0 + (G1 - G0) * i / 60
    s = (z - G0) / (G1 - G0)
    base = 0.0145 + 0.0035 * math.sin(s * math.pi)  # swell in the middle of the hand
    ring = []
    for k in range(16):
        a = k / 16 * math.tau
        ridge = 0.0012 * max(0, math.sin(a + z * 260)) ** 3   # a spiral leather wrap
        ring.append(Vector((math.cos(a) * (base + ridge) * 1.08, math.sin(a) * (base + ridge) * 0.92, z)))
    rings.append(ring)
obj('grip', loft(rings), LEATHER, sharp=70)
for z, h in ((G1 + 0.004, 0.008), (G0 - 0.003, 0.008)):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.0185, radius2=0.0185, depth=h)
    bmesh.ops.translate(bm, vec=(0, 0, z), verts=bm.verts)
    bmesh.ops.bevel(bm, geom=bm.edges[:], offset=0.0015, segments=2, affect='EDGES')
    obj('ferrule', bm, BRASS, sharp=60)

# ---- pommel: a faceted wheel (lathe profile, then flattened across the flats)
prof = [(0.0, -0.088), (0.012, -0.090), (0.024, -0.098), (0.031, -0.112), (0.032, -0.124), (0.029, -0.138),
        (0.021, -0.148), (0.011, -0.152), (0.0, -0.153)]
bm = bmesh.new()
S = 24
ringsv = []
for x, z in prof:
    ringsv.append([bm.verts.new((math.cos(k / S * math.tau) * x, math.sin(k / S * math.tau) * x, z)) for k in range(S)])
for a, b in zip(ringsv, ringsv[1:]):
    for k in range(S):
        j = (k + 1) % S
        bm.faces.new((a[k], a[j], b[j], b[k]))
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
for v in bm.verts:
    v.co.y *= 0.62  # wheel, not ball
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
obj('pommel', bm, IRON, sharp=40)
bm = bmesh.new()  # brass boss on each face of the wheel
for sy in (-1, 1):
    tmp = bmesh.new()
    bmesh.ops.create_cone(tmp, cap_ends=True, segments=16, radius1=0.013, radius2=0.009, depth=0.006)
    bmesh.ops.rotate(tmp, verts=tmp.verts, cent=(0, 0, 0), matrix=__import__('mathutils').Matrix.Rotation(math.pi / 2 * sy, 3, 'X'))
    bmesh.ops.translate(tmp, vec=(0, sy * 0.0205, -0.123), verts=tmp.verts)
    me = bpy.data.meshes.new('t'); tmp.to_mesh(me); tmp.free(); bm.from_mesh(me); bpy.data.meshes.remove(me)
obj('boss', bm, BRASS, sharp=50)

# ---- one object, one node: join (materials stay separate primitives)
bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = bpy.data.objects['blade']
bpy.ops.object.join()
o = bpy.context.active_object
o.name = 'longsword'
tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
print(f'longsword: {len(o.data.vertices)} verts, {tris} tris, {len(o.data.materials)} materials')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=False, export_apply=True, export_yup=True)
print('wrote', out)
