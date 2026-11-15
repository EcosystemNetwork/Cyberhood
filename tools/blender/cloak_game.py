"""Build a game-ready hooded cloak for a Mixamo-rigged hero, textured from a Tripo cloak sculpt.

    blender -b --python tools/blender/cloak_game.py -- \\
        game/assets/characterart/human_game.glb "game/assets/3ditems/green hooded cloak 3d model.glb" \\
        game/assets/3ditems/green_cloak.glb

Auto-fitting the rigid sculpt itself (tools/blender/cloak_gear.py) tore and bulged, so this builds
clean geometry around the body instead and keeps the sculpt only for its look:

  1 pose the body in idle frame 0 and measure it: how far it reaches (arms included) at every
    angle round the spine and every height, and the head's shape in every direction; then widen
    that, smoothly, over where the arms swing back to (relative to the chest) in walk and run
  2 cape: a grid from the shoulders to mid-calf, open at the front. Each ring hangs straight down
    from the widest point above it (cloth falls, it doesn't tuck in under a bulge), flares a
    little toward the hem, has soft folds, and a torn hem. Above the shoulders a capelet closes
    in to the neck
  3 hood: a shell a little outside the head, open at the face, with a soft point at the back,
    its lower edge flaring onto the shoulders over the capelet
  4 texture: bake the sculpt's colours onto both (Cycles, selected → active), so it keeps the
    sculpt's fabric, folds and trim
  5 skin: hood on Head → Neck → Spine2; capelet on Spine2 (and a touch of the shoulders); the cape
    hangs from Spine2 on spring strands down its columns (cape_<c>_<k>), simulated by glbhero.js.
    The side panels beside the arms also ride the arm (upper arm, some forearm lower down), so
    running doesn't punch the elbows and hands out through the cloth. No leg weights
  6 un-skin to the bind pose and export the armature (with strands) and the two meshes
"""
import math
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
BODY, SCULPT, OUT = argv[0], argv[1], argv[2]  # SCULPT: the reference the colours and trim follow

GAP = 0.018          # cloth stands this far off the body (model units, body ≈ 1 tall)
HEM = 0.24           # cape hem height (mid-calf)
FLARE = 0.08         # extra radius at the hem (an A-line, not a box hanging off the shoulders)
FOLDS, FOLD_AMP = 9, (0.006, 0.02)  # soft vertical folds: count round the back, depth top → hem
TEAR = 0.05          # how ragged the hem is
OPEN = 150           # the cape spans ±OPEN degrees from straight behind (a slit open at the front)
COLS, ROWS = 36, 22  # cape grid
STRANDS = [-132, -90, -45, 0, 45, 90, 132]   # simulated strand angles (two at the sides, where the arms are)
SEGS = 4
ARM_GRIP, ARM_SPREAD = 0.5, 38   # how much the side panels ride the arm, and how far round (deg)
FORE_SHARE = 0.5                  # of that, the share the forearm takes down by the hand
SWEEP_CLIPS = ('walk', 'run')     # clips whose arm swing the cape is widened to cover …
SWEEP_K, SWEEP_MAX = 0.4, 0.035   # … this much of the way, by at most this much,
SWEEP_BACK = 115                  # only behind this angle (the back-swing; forward the cape is open)
HOOD_GAP, HOOD_POINT = 0.03, 0.05   # hood offset from the head; size of the soft point at the back
HOOD_BRIM = 0.022    # the face opening's rim stands this far forward of the head, framing the face
FACE_HALF = 52       # half-width (deg, round the head) of the face opening at eye level
TEX_CAPE, TEX_HOOD = 1024, 512
random.seed(7)


def clamp01(x):
    return min(1.0, max(0.0, x))


def smooth(x):
    x = clamp01(x)
    return x * x * (3 - 2 * x)


bpy.ops.wm.read_factory_settings(use_empty=True)

# ---- 1 body in idle, measured
bpy.ops.import_scene.gltf(filepath=BODY)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
body = next(o for o in bpy.data.objects if o.type == 'MESH' and o.name != 'Icosphere')
for o in list(bpy.data.objects):
    if o.name == 'Icosphere':
        bpy.data.objects.remove(o, do_unlink=True)
sc = bpy.context.scene
idle = next(a for a in bpy.data.actions if a.name.split('.')[0] == 'idle')
arm.animation_data.action = idle
if idle.slots:
    arm.animation_data.action_slot = idle.slots[0]
sc.frame_set(int(idle.frame_range[0]))
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
bme = body.evaluated_get(dg).to_mesh()
bverts = [body.matrix_world @ v.co for v in bme.vertices]
body.evaluated_get(dg).to_mesh_clear()


def bone_w(n):
    return arm.matrix_world @ arm.pose.bones['mixamorig:' + n].head


F = bone_w('LeftToeBase') - bone_w('LeftFoot')
F.z = 0
F.normalize()
R = bone_w('RightArm') - bone_w('LeftArm')
R.z = 0
R.normalize()
B = -F  # straight behind
UP = Vector((0, 0, 1))
neck, hips, spine2, head = bone_w('Neck'), bone_w('Hips'), bone_w('Spine2'), bone_w('Head')
axis = Vector((bone_w('Spine1').x, bone_w('Spine1').y, 0))
shoulder_z = (bone_w('LeftArm').z + bone_w('RightArm').z) / 2


def around(p):  # angle from straight behind (deg, + toward the right side), radius, height
    d = Vector((p.x, p.y, 0)) - axis
    return math.degrees(math.atan2(d.dot(R), d.dot(B))), d.length, p.z


def at(theta, r, z):
    t = math.radians(theta)
    return axis + (B * math.cos(t) + R * math.sin(t)) * r + UP * z


ABIN, ZBIN = 5, 0.02
reach = {}
for p in bverts:
    if p.z > neck.z + 0.02:
        continue  # the head is the hood's business
    a, r, z = around(p)
    k = (int(a // ABIN), int(z // ZBIN))
    reach[k] = max(reach.get(k, 0.0), r)

# The arms swing back past the idle silhouette when walking and running. The cape rides the chest
# (Spine2), so measure where the arms go relative to the chest over those cycles and let the cape
# stand out over that too (part of the way: the side panels also ride the arms, see 5), so the
# elbows and hands push the cloth out instead of punching through it.
arm_groups = {g.index for g in body.vertex_groups
              if any(g.name.endswith(s) for s in ('Arm', 'ForeArm', 'Hand')) or 'Hand' in g.name}
arm_vi = [v.index for v in body.data.vertices if sum(gg.weight for gg in v.groups if gg.group in arm_groups) > 0.5]
sp2_pb = arm.pose.bones['mixamorig:Spine2']
sp2_idle = arm.matrix_world @ sp2_pb.matrix
sweep = {}
for name in SWEEP_CLIPS:
    act = next((a for a in bpy.data.actions if a.name.split('.')[0] == name), None)
    if not act:
        continue
    arm.animation_data.action = act
    if act.slots:
        arm.animation_data.action_slot = act.slots[0]
    for f in range(int(act.frame_range[0]), int(act.frame_range[1]) + 1, 2):
        sc.frame_set(f)
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me_ = body.evaluated_get(dg).to_mesh()
        to_idle = sp2_idle @ (arm.matrix_world @ sp2_pb.matrix).inverted()  # this frame's chest → idle chest
        for vi in arm_vi:
            a, r, z = around(to_idle @ (body.matrix_world @ me_.vertices[vi].co))
            if abs(a) > SWEEP_BACK or z > neck.z:
                continue
            k = (int(a // ABIN), int(z // ZBIN))
            sweep[k] = max(sweep.get(k, 0.0), r)
        body.evaluated_get(dg).to_mesh_clear()
arm.animation_data.action = idle
if idle.slots:
    arm.animation_data.action_slot = idle.slots[0]
sc.frame_set(int(idle.frame_range[0]))
bpy.context.view_layer.update()
extra = {k: min(SWEEP_MAX, max(0.0, r - reach.get(k, 0.0)) * SWEEP_K) for k, r in sweep.items()}
grown = 0  # spread each bin's extra smoothly over its neighbours, so the cloth bells out, not lumps
for (a0, z0) in {(a + da, z + dz) for (a, z) in extra for da in range(-4, 5) for dz in range(-5, 6)}:
    e = max((x * math.exp(-((a0 - a) / 2.5) ** 2 - ((z0 - z) / 3.5) ** 2)
             for (a, z), x in extra.items() if abs(a - a0) <= 4 and abs(z - z0) <= 5), default=0.0)
    if e > 1e-4:
        reach[(a0, z0)] = reach.get((a0, z0), 0.0) + e
        grown += 1
print('SWEEP', len(arm_vi), 'arm verts;', grown, 'bins grown')


def body_r(theta, z):
    a, zz = int(theta // ABIN), int(z // ZBIN)
    return max((reach.get((a + da, zz + dz), 0.0) for da in (-2, -1, 0, 1, 2) for dz in (-1, 0, 1)), default=0.0)


# ---- 2 cape (with capelet)
top_z = shoulder_z + 0.035   # where the capelet meets the cape
neck_r = max(0.035, min((body_r(t, neck.z) for t in range(-60, 61, 10)), default=0.05)) + GAP
cape_rows = []
for j in range(ROWS + 1):  # j=0 at the neck, capelet rows first, then hanging rows to the hem
    cape_rows.append(j)
CAP_ROWS = 5


# The shoulders' top surface: for each direction round the neck and each distance out from the
# spine, the highest point of the body there (neck down to the upper arms). The capelet lies on it,
# so it slopes down with the shoulders instead of jutting out flat like a shoulder pad.
RBIN = 0.01
top_s = {}
for p in bverts:
    if neck.z - 0.25 < p.z < neck.z + 0.01:
        a_, r_, z_ = around(p)
        k_ = (int(a_ // ABIN), int(r_ // RBIN))
        top_s[k_] = max(top_s.get(k_, -1.0), z_)


def surface_z(th, r):  # highest body point at this direction and distance out (None past the body)
    a_, rr = int(th // ABIN), int(r // RBIN)
    vals = [top_s[(a_ + da, rr + dr)] for da in (-1, 0, 1) for dr in (-1, 0, 1) if (a_ + da, rr + dr) in top_s]
    return max(vals) if vals else None


def edge_r(th):  # how far out the capelet reaches: just past the body (deltoids at the sides)
    return max(body_r(th, shoulder_z - dz / 100) for dz in range(0, 9, 2)) + GAP * 1.6


capelet = {}  # th → [(r, z)] rings from the neck out to the edge
for th in [-OPEN + 2 * OPEN * i / COLS for i in range(COLS + 1)]:
    ring, z_prev = [], neck.z + 0.012
    for j in range(CAP_ROWS + 1):
        k = j / CAP_ROWS
        r = neck_r + (edge_r(th) - neck_r) * k
        zs = surface_z(th, r)
        z = (zs + GAP * 2.4) if zs is not None else z_prev - 0.02  # clears the shoulder blades as they shift
        z = min(z, z_prev)               # never climbs back up going outward
        ring.append((r, z))
        z_prev = z
    capelet[round(th, 4)] = ring


def cap_r(th, z):  # the capelet's radius at a height (the hood's cowl lies on it)
    ring = capelet[min(capelet, key=lambda t: abs(t - th))]
    for (r0, z0), (r1, z1) in zip(ring, ring[1:]):
        if z1 <= z <= z0 and z0 > z1:
            return r0 + (r1 - r0) * (z0 - z) / (z0 - z1)
    return ring[-1][0] if z < ring[-1][1] else ring[0][0]


thetas = [-OPEN + 2 * OPEN * i / COLS for i in range(COLS + 1)]
hem_jag = [random.uniform(-1, 1) for _ in thetas]
fold_ph = [random.uniform(0, 2 * math.pi) for _ in range(3)]
# The hanging cloth, in three passes, so it drapes like cloth instead of following every bump:
#  a) how far out each point must be: off the widest point above it (cloth falls, it doesn't tuck
#     in under a bulge), plus the gap
#  b) round each row, the cloth is stretched across the hollows between the back and the arms
#     (a convex hull of the row seen from above), and down each column it runs in straight lines
#     from the capelet's edge over whatever sticks out (an upper hull of radius against height)
#  c) then the flare toward the hem, the folds and the torn hem
NH = ROWS - CAP_ROWS
zs = [[0.0] * len(thetas) for _ in range(NH + 1)]
need = [[0.0] * len(thetas) for _ in range(NH + 1)]
for i, th in enumerate(thetas):
    ring = capelet[round(th, 4)]
    z0, r0 = ring[-1][1], ring[-1][0]
    zs[0][i], need[0][i] = z0, r0
    for h in range(1, NH + 1):
        k = h / NH
        z = z0 + (HEM - z0) * k
        widest = max([body_r(th, zz / 100) for zz in range(int(z * 100), int(z0 * 100) + 1, 2)] + [r0 - GAP * 1.6])
        zs[h][i], need[h][i] = z, widest + GAP * (1 + 0.6 * (1 - smooth(k / 0.35)))


def ray_hits(th, pa, pb):  # radius where the ray out from the spine at angle th crosses chord pa-pb
    t = math.radians(th)
    d = (math.cos(t), math.sin(t))   # in (behind, right) coordinates
    ex, ey = pb[0] - pa[0], pb[1] - pa[1]
    den = d[0] * ey - d[1] * ex
    if abs(den) < 1e-9:
        return 0.0
    s = (pa[0] * ey - pa[1] * ex) / den
    u = (pa[0] * d[1] - pa[1] * d[0]) / den
    return s if s > 0 and 0 <= u <= 1 else 0.0


for h in range(1, NH + 1):  # b) round each row
    pts = [(r * math.cos(math.radians(th)), r * math.sin(math.radians(th))) for th, r in zip(thetas, need[h])]
    out = list(need[h])
    for i, th in enumerate(thetas):
        for a in range(max(0, i - 14), i):
            for b in range(i + 1, min(len(thetas), i + 15)):
                out[i] = max(out[i], ray_hits(th, pts[a], pts[b]))
    need[h] = out
for i in range(len(thetas)):  # … and down each column
    col = [need[h][i] for h in range(NH + 1)]
    for h in range(1, NH):
        for a in range(0, h):
            for b in range(h + 1, NH + 1):
                f = (zs[a][i] - zs[h][i]) / max(1e-6, zs[a][i] - zs[b][i])
                col[h] = max(col[h], col[a] + (col[b] - col[a]) * f)
    for h in range(NH + 1):
        need[h][i] = col[h]

grid = []
for j in range(ROWS + 1):
    row = []
    for i, th in enumerate(thetas):
        ring = capelet[round(th, 4)]
        if j <= CAP_ROWS:  # capelet: lies on the shoulders from the neck out
            r, z = ring[j]
        else:              # c) flare, folds (a little irregular, deepening toward the hem), torn hem
            h = j - CAP_ROWS
            k = h / NH
            z, r = zs[h][i], need[h][i]
            tr = math.radians(th)
            fold = (math.sin(tr * FOLDS + fold_ph[0]) + 0.45 * math.sin(tr * FOLDS * 1.7 + fold_ph[1] + k * 1.5)
                    + 0.25 * math.sin(tr * FOLDS * 2.9 + fold_ph[2])) / 1.7
            r += FLARE * k * k + fold * (FOLD_AMP[0] + (FOLD_AMP[1] - FOLD_AMP[0]) * smooth(k))
            if j == ROWS:  # torn hem: ragged length, shorter toward the open front
                z += TEAR * (0.5 + 0.5 * hem_jag[i]) + 0.06 * (abs(th) / OPEN) ** 2
        row.append(at(th, r, z))
    grid.append(row)


def grid_mesh(name, grid, uv_rows):
    me = bpy.data.meshes.new(name)
    verts = [p for row in grid for p in row]
    w = len(grid[0])
    faces = [(j * w + i, j * w + i + 1, (j + 1) * w + i + 1, (j + 1) * w + i)
             for j in range(len(grid) - 1) for i in range(w - 1)]
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li, vi in zip(poly.loop_indices, poly.vertices):
            j, i = divmod(vi, w)
            uv.data[li].uv = (i / (w - 1), uv_rows(j))
    me.update()
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
    return ob


cape = grid_mesh('cape', grid, lambda j: 1 - j / ROWS)

# ---- 3 hood: a smooth ellipsoid a little outside the head (sized from the head's extent each way,
# so hair bumps don't show), a soft point at the back, the bottom flaring onto the shoulders, and an
# oval face opening that closes above the brow
hc = head + UP * 0.05
hverts = [p for p in bverts if p.z > neck.z + 0.01]
ext = {
    'back': max((p - hc).dot(B) for p in hverts), 'front': max((p - hc).dot(F) for p in hverts),
    'right': max((p - hc).dot(R) for p in hverts), 'left': max(-(p - hc).dot(R) for p in hverts),
    'up': max((p - hc).z for p in hverts),
}
def face_open(e):  # front half-angle of the opening at elevation e: oval, closed above the brow
    if e > 14:   # closed above the brow
        return 0
    if e > -8:   # rounding off over the forehead
        return FACE_HALF * math.sqrt(max(0.0, 1 - ((e + 8) / 22) ** 2))
    return FACE_HALF if e > -40 else FACE_HALF * 1.2  # open down past the chin to the neck



HC, HR = 40, 22
hgrid = []
elev = [-78 + (90 + 78) * j / HR for j in range(HR + 1)]  # from the collar up to the crown
for j, e in enumerate(elev):
    row = []
    span = 180 - face_open(e)  # each ring stops exactly at the face opening: a smooth oval edge
    for i in range(HC + 1):
        a = -span + 2 * span * i / HC
        ar, er = math.radians(a), math.radians(e)
        cb, sr = math.cos(ar), math.sin(ar)
        ce, se = math.cos(er), math.sin(er)
        # ellipsoid: pick the semi-axis on each side, then add the gap
        rx = (ext['back'] if cb > 0 else ext['front']) + HOOD_GAP
        ry = (ext['right'] if sr > 0 else ext['left']) + HOOD_GAP
        rz = ext['up'] + HOOD_GAP if se > 0 else ext['up'] * 0.9 + HOOD_GAP
        p = hc + B * (cb * ce * rx) + R * (sr * ce * ry) + UP * (se * rz)
        # soft point at the back of the crown
        p += (B * 0.8 + UP * 0.2) * HOOD_POINT * math.exp(-((a / 40) ** 2) - (((e - 30) / 22) ** 2))
        # below the jaw the hood flares out onto the shoulders
        if e < -20:  # below the jaw the cowl lies on the capelet, ending just below the shoulders
            k = smooth((-20 - e) / 58)
            z_jaw = hc.z + math.sin(math.radians(-20)) * rz
            z = z_jaw + ((top_z - 0.03) - z_jaw) * k
            hor = Vector((p.x - axis.x, p.y - axis.y, 0))
            th = math.degrees(math.atan2(hor.dot(R), hor.dot(B)))
            on = at(th, cap_r(th, min(z, neck.z + 0.03) if z > top_z else z) + 0.012, z)
            p = p.lerp(on, smooth((-20 - e) / 25))
        # the rim round the face opening stands forward, so it frames the face like a hood's brim
        if face_open(e) > 0:
            edge = math.exp(-(min(i, HC - i) / 2.2) ** 2)
            p += F * HOOD_BRIM * edge * smooth((e + 40) / 25)
        row.append(p)
    hgrid.append(row)
hood = grid_mesh('hood', hgrid, lambda j: j / HR)
FACE_V = (14 + 78) / (90 + 78)  # the hood's v where the face opening closes (elevation 14)


print('BUILT cape', len(cape.data.vertices), 'verts; hood', len(hood.data.vertices), 'verts')

def face_out(ob, centre_of):  # grid faces wind one way: flip them all if they point inward
    me = ob.data
    out = sum((ob.matrix_world.to_3x3() @ p.normal).dot((ob.matrix_world @ p.center) - centre_of(ob.matrix_world @ p.center))
              for p in me.polygons)
    if out < 0:
        for p in me.polygons:
            p.flip()
        me.update()


face_out(cape, lambda p: Vector((axis.x, axis.y, p.z)))
face_out(hood, lambda p: hc)

# ---- 4 texture: a woven deep-green fabric in the sculpt's colours, soft fold shading, a darker hem,
# and a gold vine-stitch trim down the front edges, along the hem and round the hood's lower edge
import numpy as np

GREEN0, GREEN1 = np.array([0.075, 0.16, 0.095]), np.array([0.13, 0.25, 0.15])
TRIM_BG, GOLD = np.array([0.05, 0.075, 0.05]), np.array([0.62, 0.5, 0.24])


def fabric(size, trims, folds):
    v, u = np.mgrid[0:size, 0:size] / (size - 1)          # v = 0 at the bottom row of the image
    rng = np.random.default_rng(3)
    weave = 0.5 + 0.5 * np.sin(u * size * 0.9) * np.sin(v * size * 0.9)
    grain = rng.random((size, size))
    blot = np.sin(u * 13 + np.sin(v * 9) * 2) * np.sin(v * 11 + u * 3) * 0.5 + 0.5
    t = np.clip(0.35 * blot + 0.12 * weave + 0.08 * grain, 0, 1)[..., None]
    col = GREEN0 + (GREEN1 - GREEN0) * t
    shade = 1 - 0.12 * (0.5 + 0.5 * np.sin(u * np.pi * 2 * folds + np.sin(v * 6) * 0.8))
    col *= shade[..., None]
    for kind, lo, hi, *upto in trims:  # bands in u or v (optionally only up to `upto` along it):
        x, along = (u, v) if kind == 'u' else (v, u)  # a dark border with a gold vine stitched along it
        band = (x >= lo) & (x <= hi) & (along <= (upto[0] if upto else 2))
        m = (x[band] - lo) / max(1e-6, hi - lo)
        vine = np.abs(m - 0.5 - 0.28 * np.sin(along[band] * 60)) < 0.11      # the winding stem
        leaf = (np.sin(along[band] * 120) > 0.75) & (np.abs(m - 0.5) < 0.32)  # leaves along it
        edge = (m < 0.08) | (m > 0.92)                                       # stitched borders
        c = np.repeat(TRIM_BG[None, :], band.sum(), 0)
        c[vine | leaf | edge] = GOLD * (0.85 + 0.15 * grain[band][vine | leaf | edge])[:, None]
        col[band] = c
    return np.concatenate([np.clip(col, 0, 1), np.ones((size, size, 1))], axis=2)


for ob, size, trims, folds in (
    (cape, TEX_CAPE, [('u', 0.0, 0.035), ('u', 0.965, 1.0), ('v', 0.04, 0.085)], 9),
    (hood, TEX_HOOD, [('v', 0.0, 0.07), ('u', 0.0, 0.03, FACE_V), ('u', 0.97, 1.0, FACE_V)], 6),  # collar, face rim
):
    img = bpy.data.images.new(ob.name + '_tex', size, size)
    img.pixels.foreach_set(fabric(size, trims, folds).astype(np.float32).ravel())
    img.pack()
    mat = bpy.data.materials.new(ob.name + '_mat')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.85
    mat.use_backface_culling = False
    ob.data.materials.append(mat)
    # lining for the inside of the thickness (slot 1): the same weave, darker and plainer
    lin = bpy.data.images.new(ob.name + '_lining', 256, 256)
    lin.pixels.foreach_set((fabric(256, [], folds) * np.array([0.55, 0.6, 0.55, 1.0])).astype(np.float32).ravel())
    lin.pack()
    lm = bpy.data.materials.new(ob.name + '_lining_mat')
    lm.use_nodes = True
    lt = lm.node_tree.nodes.new('ShaderNodeTexImage')
    lt.image = lin
    lm.node_tree.links.new(lt.outputs['Color'], lm.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
    lm.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 0.9
    ob.data.materials.append(lm)
    print('TEXTURED', ob.name, size)

# ---- 4b clasp: a gold brooch on each front edge at the chest, a chain sagging between them
GOLD_MAT = bpy.data.materials.new('clasp_gold')
GOLD_MAT.use_nodes = True
gb = GOLD_MAT.node_tree.nodes.get('Principled BSDF')
gb.inputs['Base Color'].default_value = (0.78, 0.6, 0.24, 1)
gb.inputs['Metallic'].default_value = 0.85
gb.inputs['Roughness'].default_value = 0.32
row = CAP_ROWS + 2
L, Rr = grid[row][0], grid[row][-1]
fwd_of = lambda p: Vector((p.x - axis.x, p.y - axis.y, 0)).normalized()
parts_ = []


def rod(a, b, r):
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=r, depth=d.length, location=(a + b) / 2)
    o = bpy.context.active_object
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    parts_.append(o)


for p in (L, Rr):
    n = fwd_of(p)
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.017, depth=0.007, location=p + n * 0.008)
    o = bpy.context.active_object
    o.rotation_euler = n.to_track_quat('Z', 'Y').to_euler()
    parts_.append(o)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=0.008, location=p + n * 0.013)
    parts_.append(bpy.context.active_object)  # the stone
mid = (L + Rr) / 2 - UP * 0.03 + fwd_of((L + Rr) / 2) * 0.01
rod(L + fwd_of(L) * 0.01, mid, 0.0028)
rod(mid, Rr + fwd_of(Rr) * 0.01, 0.0028)
for o in bpy.data.objects:
    o.select_set(o in parts_)
bpy.context.view_layer.objects.active = parts_[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.join()
clasp = bpy.context.view_layer.objects.active
clasp.name = 'clasp'
clasp.data.materials.clear()
clasp.data.materials.append(GOLD_MAT)
print('CLASP', len(clasp.data.vertices), 'verts')

# ---- 5 skin
# strand bones down the cape columns nearest the strand angles; knots on the posed cape
col_of = [min(range(len(thetas)), key=lambda i: abs(thetas[i] - s)) for s in STRANDS]
row_knots = [CAP_ROWS + round((ROWS - CAP_ROWS) * k / SEGS) for k in range(SEGS + 1)]
pb_sp = arm.pose.bones['mixamorig:Spine2']
to_rest = arm.matrix_world.inverted() @ (arm.matrix_world @ pb_sp.matrix @ pb_sp.bone.matrix_local.inverted() @ arm.matrix_world.inverted()).inverted()
bpy.context.view_layer.objects.active = arm
for o in bpy.data.objects:
    o.select_set(o == arm)
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
for c, ci in enumerate(col_of):
    parent = eb['mixamorig:Spine2']
    for k in range(SEGS + 1):
        b = eb.new(f'cape_{c}_{k}' if k < SEGS else f'cape_{c}_end')
        h = grid[row_knots[k]][ci]
        t = grid[row_knots[k + 1]][ci] if k < SEGS else h + (h - grid[row_knots[k - 1]][ci]) * 0.3
        b.head, b.tail = to_rest @ h, to_rest @ t
        b.parent = parent
        b.use_connect = False
        b.use_deform = k < SEGS
        parent = b
bpy.ops.object.mode_set(mode='OBJECT')

arm_th, arm_len = {}, {}  # each arm's angle round the spine (idle) and shoulder → hand drop
for sd in ('Left', 'Right'):
    sh, el, hd = bone_w(sd + 'Arm'), bone_w(sd + 'ForeArm'), bone_w(sd + 'Hand')
    arm_th[sd] = abs(around((sh + el) / 2)[0])
    arm_len[sd] = max(0.1, shoulder_z - hd.z)
print('ARMS', {k: round(v) for k, v in arm_th.items()}, {k: round(v, 3) for k, v in arm_len.items()})

W = {}  # object → per-vertex weights
cw = []
for j in range(ROWS + 1):
    for i, th in enumerate(thetas):
        ws = {}
        if j <= CAP_ROWS:
            # over the deltoids the cloth rides the shoulder (and a little of the upper arm), more
            # toward the edge, so a raised arm lifts it instead of punching through
            side = math.exp(-((abs(th) - 95) / 40) ** 2) * smooth(j / CAP_ROWS)
            sd = 'Right' if th > 0 else 'Left'
            ws['mixamorig:Spine2'] = 1 - 0.75 * side
            ws[f'mixamorig:{sd}Shoulder'] = 0.35 * side
            ws[f'mixamorig:{sd}Arm'] = 0.4 * side
        else:
            u = (j - CAP_ROWS) / (ROWS - CAP_ROWS) * SEGS  # position down the strand, in bones
            # the top rests on the back; over the arms only the very top, so the arm colliders can
            # push the sides out of the way
            reach_ = 1.2 - 0.85 * math.exp(-((abs(th) - 100) / 40) ** 2)
            pin = 1 - smooth(u / reach_)
            # across: the two strands either side of this column
            sw = [max(0.0, 1 - abs(th - s) / 46) for s in STRANDS]
            if sum(sw) < 1e-6:
                sw[min(range(len(STRANDS)), key=lambda c: abs(th - STRANDS[c]))] = 1
            t = sum(sw)
            seg = [max(0.0, 1 - abs(u - (k + 0.5))) for k in range(SEGS)]
            if u < 0.5:
                seg[0] = 1.0
            if u > SEGS - 0.5:
                seg[-1] = 1.0
            ss = sum(seg)
            for c, w0 in enumerate(sw):
                for k, wk in enumerate(seg):
                    if w0 > 0 and wk > 0:
                        ws[f'cape_{c}_{k}'] = ws.get(f'cape_{c}_{k}', 0) + (1 - pin) * w0 / t * wk / ss
            ws['mixamorig:Spine2'] = ws.get('mixamorig:Spine2', 0) + pin
            # the side panels over the arms ride the upper arm, so a back-swing (running, walking)
            # carries the cloth back with it instead of the elbow punching out through it. Strongest
            # right beside the arm and down to about the elbow, fading out by the hand and to the back
            sd = 'Right' if th > 0 else 'Left'
            down = (shoulder_z - grid[j][i].z) / arm_len[sd]           # 0 at the shoulder, 1 at the hand
            a = ARM_GRIP * math.exp(-((abs(th) - arm_th[sd]) / ARM_SPREAD) ** 2) * (1 - smooth((down - 0.55) / 0.75))
            if a > 1e-3:
                for g in ws:
                    ws[g] *= 1 - a
                fore = FORE_SHARE * smooth((down - 0.3) / 0.45)  # lower down, the forearm takes some
                ws[f'mixamorig:{sd}Arm'] = ws.get(f'mixamorig:{sd}Arm', 0) + a * (1 - fore)
                ws[f'mixamorig:{sd}ForeArm'] = ws.get(f'mixamorig:{sd}ForeArm', 0) + a * fore
        cw.append(ws)
W[cape] = cw
hw = []
for j, e in enumerate(elev):
    for i in range(HC + 1):
        k = smooth((e + 10) / 30)   # head above the jaw line …
        n = smooth((e + 55) / 40)   # … neck below it, the shoulders' Spine2 at the very bottom
        ws = {'mixamorig:Head': k, 'mixamorig:Neck': (1 - k) * n, 'mixamorig:Spine2': (1 - k) * (1 - n)}
        hw.append(ws)
W[hood] = hw
W[clasp] = [{'mixamorig:Spine2': 1.0} for _ in clasp.data.vertices]

# ---- 6 un-skin to the bind pose, bind, export
skin = {pb.name: arm.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted() @ arm.matrix_world.inverted()
        for pb in arm.pose.bones}
sp2 = skin['mixamorig:Spine2']
for ob in W:  # glTF / three.js keep 4 bones per vertex: drop the rest here, so the un-skin matches
    W[ob] = [dict(sorted(ws.items(), key=lambda kv: -kv[1])[:4]) for ws in W[ob]]
for ob, ws_list in W.items():
    for v, ws in zip(ob.data.vertices, ws_list):
        M = Matrix.Diagonal((0, 0, 0, 0))
        tot = sum(ws.values()) or 1
        for g, w in ws.items():
            M = M + skin.get(g, sp2) * (w / tot)  # strands are new: at rest they ride Spine2
        v.co = ob.matrix_world.inverted() @ (M.inverted_safe() @ (ob.matrix_world @ v.co))
    for g in {g for ws in ws_list for g in ws}:
        ob.vertex_groups.new(name=g)
    for i, ws in enumerate(ws_list):
        tot = sum(ws.values()) or 1
        for g, w in ws.items():
            if w / tot > 1e-3:
                ob.vertex_groups[g].add([i], w / tot, 'REPLACE')
    ob.parent = arm
    if ob in (cape, hood):  # cloth thickness: the inner shell takes the lining (material slot 1)
        so = ob.modifiers.new('thick', 'SOLIDIFY')
        so.thickness, so.offset, so.use_even_offset = 0.006, -1.0, False  # even offset spikes at the ragged hem's points
        so.material_offset = 1
        so.use_rim = True
    m = ob.modifiers.new('arm', 'ARMATURE')
    m.object = arm
    bpy.context.view_layer.objects.active = ob
    for o in bpy.data.objects:
        o.select_set(o == ob)
    bpy.ops.object.shade_smooth()
arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.location, pb.rotation_quaternion, pb.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
bpy.data.objects.remove(body, do_unlink=True)
for o in bpy.data.objects:
    o.select_set(o in (arm, cape, hood, clasp))
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animations=False,
                          export_skins=True, export_apply=True, export_image_format='JPEG', export_jpeg_quality=88)
print('WROTE', OUT)
