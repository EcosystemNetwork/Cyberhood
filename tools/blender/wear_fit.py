"""Fit a static Tripo clothing sculpt (pants, boots, tunic) onto the Mixamo-rigged hero as skinned gear.

    blender -b --python tools/blender/wear_fit.py -- KIND BODY SCULPT OUT [UNDER.glb ...]

    KIND   pants | boots | tunic
    UNDER  gear already fitted with this script that this layer must stay outside of
           (boots and the tunic go over the pants)

The starter outfit, in layering order:

    B=game/assets/characterart/human_game.glb; G=game/assets/3ditems
    blender -b --python tools/blender/wear_fit.py -- pants $B $G/leather_pants.glb  $G/leather_pants_game.glb
    blender -b --python tools/blender/wear_fit.py -- boots $B $G/leather_boots.glb  $G/leather_boots_game.glb  $G/leather_pants_game.glb
    blender -b --python tools/blender/wear_fit.py -- tunic $B $G/medieval_tunic.glb $G/medieval_tunic_game.glb $G/leather_pants_game.glb

Unlike the cloak (tools/blender/cloak_game.py, which builds new cloth because a loose cape can't be
fitted rigidly), these garments hug the body, so the sculpt itself is warped onto it:

  1 pose the body in idle frame 0, its upper arms lowered to the angle the tunic's sleeves hang at
  2 join the sculpt's parts, decimate a copy to TRIS, unwrap it, and bake the sculpt's colours and
    surface detail (normal map) onto it (Cycles, selected → active)
  3 warp it onto the body, between landmarks matched on both (waist, crotch, knee, hem; hem,
    armpit, shoulder, collar): horizontal slices of the sculpt are re-centred on the same slice of
    the body and scaled by how much wider the body is there (smoothed down the length, so the
    garment keeps its own cut rather than every bump of the body). Pants legs follow each leg; the
    tunic's sleeves turn with the upper arm from the shoulder; each boot is laid on its foot (heel,
    toe, sole), its shaft centred on the leg and widened to take it
  4 push it out of the body (and the layers under it) to MARGIN, smoothing as it goes
  5 skin it: weights from the nearest point on the posed body (sleeves: the arm's; elsewhere the
    torso's and legs'), smoothed; a tunic's skirt rides the hips half way rather than the thighs
  6 un-skin to the bind pose and export the armature and the garment

glbhero.js attaches the result to a hero with the same skeleton (GEAR_URL / START_WEAR).
"""
import math
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:]
KIND, BODY, SCULPT, OUT = argv[:4]
UNDER = argv[4:]
CFG = {
    'pants': dict(tris=9000, tex=1024, margin=0.0055, ease=1.04, rough=0.5),
    'boots': dict(tris=8000, tex=1024, margin=0.0045, ease=1.0, rough=0.55),
    'tunic': dict(tris=12000, tex=1024, margin=0.007, ease=1.06, rough=0.75),
}[KIND]
ARM_DROP = 50   # deg below horizontal the upper arms are posed at to fit (where the tunic's sleeves point)


def smooth(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def interp_x(x, xp, fp):  # piecewise linear, extended past the ends along the end segments
    x = np.asarray(x, float)
    y = np.interp(x, xp, fp)
    lo, hi = x < xp[0], x > xp[-1]
    y[lo] = fp[0] + (x[lo] - xp[0]) * (fp[1] - fp[0]) / (xp[1] - xp[0])
    y[hi] = fp[-1] + (x[hi] - xp[-1]) * (fp[-1] - fp[-2]) / (xp[-1] - xp[-2])
    return y


def gauss(a, sigma):  # smooth a 1-D series (NaN-free) along its length
    if sigma <= 0:
        return a
    r = int(3 * sigma) + 1
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.pad(a, [(r, r)] + [(0, 0)] * (a.ndim - 1), mode='edge')
    if a.ndim == 1:
        return np.convolve(pad, k, 'valid')
    return np.stack([np.convolve(pad[:, i], k, 'valid') for i in range(a.shape[1])], 1)


class Slices:
    """Horizontal slices of a point cloud: per height, the centre and half-extent in x and y."""

    def __init__(self, pts, z0, z1, step, win, sm_c=1.0, sm_h=3.0, minpts=8):
        p = pts[np.argsort(pts[:, 2])]
        z = p[:, 2]
        self.z = np.arange(z0, z1 + 1e-9, step)
        C, H, ok = [], [], []
        for zz in self.z:
            a, b = np.searchsorted(z, [zz - win, zz + win])
            s = p[a:b, :2]
            if len(s) < minpts:
                C.append((0, 0)); H.append((0, 0)); ok.append(False)
                continue
            q0, q1 = np.percentile(s, 1.5, 0), np.percentile(s, 98.5, 0)
            C.append((q0 + q1) / 2); H.append((q1 - q0) / 2); ok.append(True)
        C, H, ok = np.array(C, float), np.array(H, float), np.array(ok)
        if not ok.any():
            raise RuntimeError('no points to slice')
        for arr in (C, H):  # fill empty slices from their neighbours
            for i in range(2):
                arr[~ok, i] = np.interp(self.z[~ok], self.z[ok], arr[ok, i])
        self.C, self.H = gauss(C, sm_c), np.maximum(gauss(H, sm_h), 1e-3)

    def at(self, z):
        z = np.asarray(z, float)
        return (np.stack([np.interp(z, self.z, self.C[:, i]) for i in range(2)], -1),
                np.stack([np.interp(z, self.z, self.H[:, i]) for i in range(2)], -1))


def ratio_fn(s_sl, b_sl, fz, sigma=4.0):  # body/sculpt half-extent per sculpt height, smoothed
    zs = s_sl.z
    _, hb = b_sl.at(fz(zs))
    r = hb / s_sl.H
    med = np.median(r, 0)
    r = gauss(np.clip(r, med * 0.75, med * 1.33), sigma)  # a ragged end slice (the hem's fringe) can't blow it up
    return lambda z: np.stack([np.interp(z, zs, r[:, i]) for i in range(2)], -1)


bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene


def drop_icospheres():
    for o in list(bpy.data.objects):
        if o.name.startswith('Icosphere'):
            bpy.data.objects.remove(o, do_unlink=True)


# ---- 1 body, posed
bpy.ops.import_scene.gltf(filepath=BODY)
drop_icospheres()
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
body = next(o for o in bpy.data.objects if o.type == 'MESH')
idle = next(a for a in bpy.data.actions if a.name.split('.')[0] == 'idle')
arm.animation_data.action = idle
if idle.slots:
    arm.animation_data.action_slot = idle.slots[0]
sc.frame_set(int(idle.frame_range[0]))
bpy.context.view_layer.update()
basis = {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}
arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.matrix_basis = basis[pb.name]
bpy.context.view_layer.update()


def bone_w(n):
    return arm.matrix_world @ arm.pose.bones['mixamorig:' + n].head


for sd, sx in (('Left', 1), ('Right', -1)):  # upper arms down to ARM_DROP (rotated about the shoulder)
    pb = arm.pose.bones[f'mixamorig:{sd}Arm']
    h = bone_w(sd + 'Arm')
    d = (bone_w(sd + 'ForeArm') - h).normalized()
    a = math.radians(ARM_DROP)
    t = Vector((sx * math.cos(a), d.y, -math.sin(a))).normalized()
    q = d.rotation_difference(t)
    pb.matrix = Matrix.Translation(h) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h) @ pb.matrix
    bpy.context.view_layer.update()
FIT_BASIS = {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}


def posed_mesh(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    M = np.array(ob.matrix_world)
    co = co.reshape(-1, 3).astype(float) @ M[:3, :3].T + M[:3, 3]
    tri = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get('vertices', tri)
    nrm = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('normal', nrm)
    ev.to_mesh_clear()
    posed_mesh.normals = nrm.reshape(-1, 3) @ M[:3, :3].T
    return co, tri.reshape(-1, 3)


bco, btri = posed_mesh(body)
bnrm = posed_mesh.normals
gnames = [g.name for g in body.vertex_groups]
BW = np.zeros((len(body.data.vertices), len(gnames)))
for v in body.data.vertices:
    for g in v.groups:
        BW[v.index, g.group] = g.weight
BW /= np.maximum(BW.sum(1, keepdims=True), 1e-9)
gi = {n: i for i, n in enumerate(gnames)}
short = [n.replace('mixamorig:', '') for n in gnames]
armw = BW[:, [i for i, n in enumerate(short) if 'Arm' in n or 'Hand' in n]].sum(1)
headw = BW[:, [i for i, n in enumerate(short) if 'Head' in n]].sum(1)
torso_v = (armw < 0.5) & (headw < 0.5)          # trunk, neck and legs
side_arm_v = {sd: BW[:, [i for i, n in enumerate(short) if n.startswith(sd) and ('Arm' in n or 'Shoulder' in n)]].sum(1) > 0.5
              for sd in ('Left', 'Right')}
hips_c = bone_w('Hips')
P = {n: bone_w(n) for n in ('Hips', 'Spine', 'Spine2', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm',
                            'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot',
                            'LeftToe_End', 'RightToe_End')}


def surface_pts(co, tri, vmask=None):  # the vertices plus each triangle's centre: denser slices
    t = tri if vmask is None else tri[vmask[tri].all(1)]
    v = co if vmask is None else co[vmask]
    return np.concatenate([v, co[t].mean(1)])


body_trunk = surface_pts(bco, btri, torso_v)
# which leg each body vertex belongs to, by its weights (in idle the calves touch, so its side of
# the hips won't do); 0 for the trunk above
legw = {sd: BW[:, [i for i, n in enumerate(short) if n.startswith(sd) and ('Leg' in n or 'Foot' in n or 'Toe' in n)]].sum(1)
        for sd in ('Left', 'Right')}
BSIDE = np.where((legw['Left'] > legw['Right']) & (legw['Left'] > 0.25), 1,
                 np.where((legw['Right'] > legw['Left']) & (legw['Right'] > 0.25), -1, 0))
leg_pts = {sgn: surface_pts(bco, btri, torso_v & (BSIDE == sgn)) for sgn in (1, -1)}
from mathutils.kdtree import KDTree
_kd = KDTree(len(bco))
for i, p in enumerate(bco):
    _kd.insert(Vector(p), i)
_kd.balance()


def side_of(pts):  # the leg (or 0: trunk) of the nearest body vertex
    return np.array([BSIDE[_kd.find(Vector(p))[1]] for p in pts], int)


def crotch_of(pts, cx, z_hi, z_lo, gap):  # highest height below z_hi where the legs part
    for z in np.arange(z_hi, z_lo, -0.004):
        s = pts[np.abs(pts[:, 2] - z) < 0.004]
        if len(s) and not (np.abs(s[:, 0] - cx) < gap).any():
            return z
    return z_lo


# the thighs touch, so the legs never part cleanly: take the crotch from the hip joints
hipj = (bone_w('LeftUpLeg') + bone_w('RightUpLeg')) / 2
crotch_b = hipj.z - 0.25 * (bone_w('LeftUpLeg') - bone_w('LeftLeg')).length
print('BODY crotch', round(crotch_b, 3), 'hips', round(hips_c.z, 3))


def bvh_of(co, tri, vmask=None):
    t = tri if vmask is None else tri[vmask[tri].sum(1) >= 2]
    return BVHTree.FromPolygons([Vector(p) for p in co], [tuple(x) for x in t]), t


# what this layer goes over, in the same pose
under_pts, under_tris = [], []
for path in UNDER:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    drop_icospheres()
    new = [o for o in bpy.data.objects if o not in before]
    ua = next(o for o in new if o.type == 'ARMATURE')
    ua.animation_data_clear()
    for pb in ua.pose.bones:
        if pb.name in FIT_BASIS:
            pb.matrix_basis = FIT_BASIS[pb.name]
    bpy.context.view_layer.update()
    for o in new:
        if o.type == 'MESH':
            co, tri = posed_mesh(o)
            under_tris.append((co, tri))
            under_pts.append(surface_pts(co, tri))
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    print('UNDER', path)
under_all = np.concatenate(under_pts) if under_pts else np.zeros((0, 3))
under_side = side_of(under_all) if len(under_all) else np.zeros(0, int)

# ---- 2 sculpt: join, decimate, unwrap, bake
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=SCULPT)
parts = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def part_pts(o):
    a = np.empty(len(o.data.vertices) * 3, np.float32)
    o.data.vertices.foreach_get('co', a)
    return a.reshape(-1, 3).astype(float)


def tag_of(o, pts):  # which piece of the outfit a sculpt part belongs to
    mn, mx, c = pts.min(0), pts.max(0), pts.mean(0)
    if KIND == 'boots':
        return 'bootA' if c[1] < 0 else 'bootB'
    if KIND == 'tunic' and min(abs(mn[0]), abs(mx[0])) >= 0.23 and mn[0] * mx[0] > 0 and mn[2] >= 0.39:
        return 'sleeveL' if c[0] > 0 else 'sleeveR'
    return 'main'


HI = {}  # tag → sculpt points (dense: for measuring)
for o in parts:
    pts = part_pts(o)
    tag = tag_of(o, pts)
    HI.setdefault(tag, []).append(pts)
    vg = o.vertex_groups.new(name='tag_' + tag)
    vg.add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')
HI = {k: np.concatenate(v) for k, v in HI.items()}
HI_ALL = np.concatenate(list(HI.values()))
print('SCULPT', len(parts), 'parts', {k: len(v) for k, v in HI.items()})
# the low-poly copy: each part welded and decimated on its own (joined first, a collapse this heavy
# folds triangles across from one leg to the other at the crotch), small parts kept a few faces
ntri = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in parts)
lows = []
for o in parts:
    c = o.copy()
    c.data = o.data.copy()
    sc.collection.objects.link(c)
    bm = bmesh.new()
    bm.from_mesh(c.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(c.data)
    bm.free()
    nt_ = sum(len(p.vertices) - 2 for p in c.data.polygons)
    m = c.modifiers.new('dec', 'DECIMATE')
    m.ratio = min(1.0, max(CFG['tris'] / ntri, 40 / max(nt_, 1)))
    for x in bpy.data.objects:
        x.select_set(x == c)
    bpy.context.view_layer.objects.active = c
    bpy.ops.object.modifier_apply(modifier=m.name)
    lows.append(c)
for x in bpy.data.objects:
    x.select_set(x in lows)
bpy.context.view_layer.objects.active = lows[0]
bpy.ops.object.join()
lo = bpy.context.view_layer.objects.active
lo.name = KIND
for x in bpy.data.objects:
    x.select_set(x in parts)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
hi = bpy.context.view_layer.objects.active
hi.name = 'sculpt'
for o in bpy.data.objects:
    o.select_set(o == lo)
bpy.context.view_layer.objects.active = lo


# The sculpts are closed solids: each opening (hem, collar, cuffs, waist, leg ends, boot tops) is
# sealed by a lid, which on the body would sit inside it and get pushed out into a flat plate. Cut
# the lids off: faces facing out of the opening, well inside its rim (measured over the last `band`
# of it), and no deeper in than `depth` (Tripo recesses them: the tunic's hem lid sits 0.1 up).
def opening(pts, d, depth, band=0.035):
    d = np.asarray(d, float) / np.linalg.norm(d)
    proj = pts @ d
    e = np.percentile(proj, 99.8)
    ring = pts[proj > e - band]
    c = ring.mean(0)
    u = np.cross(d, (0, 0, 1) if abs(d[2]) < 0.9 else (1, 0, 0))
    u /= np.linalg.norm(u)
    w = np.cross(d, u)
    rel = ring - c
    a, r = np.arctan2(rel @ w, rel @ u), np.hypot(rel @ u, rel @ w)
    R = np.zeros(36)
    np.maximum.at(R, ((a + np.pi) / (2 * np.pi) * 36).astype(int) % 36, r)
    R = np.maximum(R, 0.5 * (np.roll(R, 1) + np.roll(R, -1)))  # fill a sparse bin from its neighbours
    return c, d, u, w, e, depth, R


def lid_faces(spec, fc, fn, keep=0.86):
    c, d, u, w, e, band, R = spec
    rel = fc - c
    a, r = np.arctan2(rel @ w, rel @ u), np.hypot(rel @ u, rel @ w)
    rr = R[((a + np.pi) / (2 * np.pi) * 36).astype(int) % 36]
    return (fn @ d > 0.6) & (fc @ d > e - band) & (r < keep * rr)


if KIND == 'tunic':
    specs = [opening(HI['main'], (0, 0, -1), 0.2), opening(HI['main'], (0, 0, 1), 0.15)]
    for tag in ('sleeveL', 'sleeveR'):
        sl = HI.get(tag)
        if sl is not None:
            J = sl[np.abs(np.abs(sl[:, 0]) - 0.255) < 0.025].mean(0)
            specs.append(opening(sl, sl[np.abs(sl[:, 0]) > 0.44].mean(0) - J, 0.1))
elif KIND == 'pants':
    specs = [opening(HI_ALL, (0, 0, 1), 0.15, band=0.05)] + [opening(HI_ALL[np.sign(HI_ALL[:, 0]) == s], (0, 0, -1), 0.12) for s in (1, -1)]
else:
    specs = [opening(HI[t], (0, 0, 1), 0.08) for t in ('bootA', 'bootB')]
fc = np.array([p.center for p in lo.data.polygons])
fn = np.array([p.normal for p in lo.data.polygons])
lid = np.zeros(len(fc), bool)
for sp in specs:
    lid |= lid_faces(sp, fc, fn)
bm = bmesh.new()
bm.from_mesh(lo.data)
bm.faces.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[bm.faces[i] for i in np.nonzero(lid)[0]], context='FACES')
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
bm.to_mesh(lo.data)
bm.free()
print('LIDS', int(lid.sum()), 'faces cut from', len(specs), 'openings')
while lo.data.uv_layers:  # the sculpt's per-part UVs overlap: unwrap afresh
    lo.data.uv_layers.remove(lo.data.uv_layers[0])
lo.data.uv_layers.new(name='UVMap').active = True
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.quads_convert_to_tris()
bpy.ops.mesh.delete_loose()
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
bpy.ops.object.mode_set(mode='OBJECT')
lo.data.materials.clear()
bpy.ops.object.shade_smooth()
print('DECIMATED', ntri, '→', len(lo.data.polygons), 'tris')

T = CFG['tex']
img_c = bpy.data.images.new(KIND + '_color', T, T)
img_n = bpy.data.images.new(KIND + '_normal', T, T)
img_n.colorspace_settings.name = 'Non-Color'
mat = bpy.data.materials.new(KIND + '_mat')
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes.get('Principled BSDF')
tc = nt.nodes.new('ShaderNodeTexImage'); tc.image = img_c
tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = img_n
nm = nt.nodes.new('ShaderNodeNormalMap')
lo.data.materials.append(mat)
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 4
bk = sc.render.bake
bk.use_selected_to_active, bk.cage_extrusion, bk.max_ray_distance, bk.margin = True, 0.012, 0.05, 6
for o in bpy.data.objects:
    o.select_set(o in (hi, lo))
bpy.context.view_layer.objects.active = lo
nt.nodes.active = tc
bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_selected_to_active=True)
nt.nodes.active = tn
bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT', use_selected_to_active=True)
nt.links.new(tc.outputs['Color'], bsdf.inputs['Base Color'])
nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
bsdf.inputs['Roughness'].default_value = CFG['rough']
img_c.pack(); img_n.pack()
bpy.data.objects.remove(hi, do_unlink=True)
print('BAKED', T)

# lo's vertices and what each came from
n = len(lo.data.vertices)
V = np.empty(n * 3, np.float32)
lo.data.vertices.foreach_get('co', V)
V = V.reshape(-1, 3).astype(float)
TAG = {}
for g in lo.vertex_groups:
    w = np.zeros(n)
    for v in lo.data.vertices:
        for gg in v.groups:
            if gg.group == g.index:
                w[v.index] = gg.weight
    TAG[g.name[4:]] = w
while lo.vertex_groups:
    lo.vertex_groups.remove(lo.vertex_groups[0])
EDGES = np.empty(len(lo.data.edges) * 2, np.int32)
lo.data.edges.foreach_get('vertices', EDGES)
EDGES = EDGES.reshape(-1, 2)


def neighbour_mean(X):
    S = np.zeros_like(X)
    c = np.zeros(len(X))
    np.add.at(S, EDGES[:, 0], X[EDGES[:, 1]]); np.add.at(S, EDGES[:, 1], X[EDGES[:, 0]])
    np.add.at(c, EDGES[:, 0], 1); np.add.at(c, EDGES[:, 1], 1)
    return S / np.maximum(c, 1)[:, None] if X.ndim > 1 else S / np.maximum(c, 1)


# ---- 3 warp onto the body
SIDE, K_SIDE = np.zeros(n), np.zeros(n)  # which leg (+1 left, -1 right) a vertex belongs to, and how much
def slice_map(X, s_sl, b_sl, fz, ratio, ease):
    zb = fz(X[:, 2])
    cs, _ = s_sl.at(X[:, 2])
    cb, _ = b_sl.at(zb)
    xy = cb + (X[:, :2] - cs) * ratio(X[:, 2]) * ease
    return np.column_stack([xy, zb])


if KIND == 'pants':
    S = HI_ALL
    crotch_s = crotch_of(S, 0.0, 0.9, 0.4, 0.008)
    knee_s = 0.415                                  # middle of the knee pads
    waist_b = hips_c.z + 0.05                      # sits on the hips, below the navel
    knee_b = (P['LeftLeg'].z + P['RightLeg'].z) / 2
    hem_b = (P['LeftFoot'].z + P['RightFoot'].z) / 2 - 0.012
    LS = [S[:, 2].min(), knee_s, crotch_s, 0.94]
    LB = [hem_b, knee_b, crotch_b, waist_b]
    fz = lambda z: interp_x(z, LS, LB)
    print('PANTS crotch', round(crotch_s, 3), 'landmarks', [round(x, 3) for x in LS], '→', [round(x, 3) for x in LB])
    s_all = Slices(S, -0.02, 1.0, 0.01, 0.006)
    b_all = Slices(body_trunk, hem_b - 0.05, waist_b + 0.08, 0.005, 0.008)
    r_all = ratio_fn(s_all, b_all, fz)
    out = slice_map(V, s_all, b_all, fz, r_all, CFG['ease'])
    for sgn in (1, -1):
        s_leg = Slices(S[(np.sign(S[:, 0]) == sgn) & (S[:, 2] < crotch_s)], -0.02, crotch_s, 0.01, 0.006)
        bl = leg_pts[sgn][leg_pts[sgn][:, 2] < crotch_b]
        b_leg = Slices(bl, hem_b - 0.05, crotch_b, 0.005, 0.008)
        r_leg = ratio_fn(s_leg, b_leg, fz)
        mine = np.sign(V[:, 0]) == sgn
        Xc = V.copy()
        Xc[:, 2] = np.minimum(Xc[:, 2], crotch_s)   # above the crotch: the leg's top slice
        leg = slice_map(Xc, s_leg, b_leg, fz, r_leg, CFG['ease'])
        leg[:, 2] = fz(V[:, 2])
        k = smooth((crotch_s + 0.03 - V[:, 2]) / 0.09)[:, None] * mine[:, None]
        out = out * (1 - k) + leg * k
        SIDE[mine], K_SIDE[mine] = sgn, k[mine, 0]

elif KIND == 'tunic':
    torso_s = HI['main']
    hem_s, armpit_s, shoulder_s, collar_s = torso_s[:, 2].min(), 0.55, 0.85, torso_s[:, 2].max()
    shoulder_b = max(bco[torso_v & (np.abs(bco[:, 0] - P[sd + 'Arm'].x) < 0.02), 2].max() for sd in ('Left', 'Right'))
    LS = [hem_s, armpit_s, shoulder_s, collar_s]
    LB = [crotch_b - 0.035, P['Spine2'].z - 0.03, shoulder_b, P['Neck'].z + 0.04]
    fz = lambda z: interp_x(z, LS, LB)
    print('TUNIC landmarks', [round(x, 3) for x in LS], '→', [round(x, 3) for x in LB])
    s_t = Slices(torso_s, hem_s - 0.02, collar_s + 0.02, 0.01, 0.006)
    b_t = Slices(body_trunk, LB[0] - 0.03, LB[-1] + 0.03, 0.005, 0.008)
    r_t = ratio_fn(s_t, b_t, fz, sigma=5.0)
    out = slice_map(V, s_t, b_t, fz, r_t, CFG['ease'])
    chest = r_t(np.array([0.62, 0.68, 0.74])).mean(0)
    for tag, sd, sgn in (('sleeveL', 'Left', 1), ('sleeveR', 'Right', -1)):
        if tag not in HI:
            continue
        sl = HI[tag]
        J = sl[np.abs(np.abs(sl[:, 0]) - 0.255) < 0.025].mean(0)      # the sleeve's root …
        cuff = sl[np.abs(sl[:, 0]) > 0.44].mean(0)                    # … and its cuff
        ax_s = Vector(cuff - J).normalized()
        Jb = P[sd + 'Arm']
        ax_b = (P[sd + 'ForeArm'] - Jb).normalized()
        R = np.array(ax_s.rotation_difference(ax_b).to_matrix())
        s = float(chest[0]) * CFG['ease']
        mapped = np.array(Jb) + ((V - J) * s) @ R.T
        t = (V - J) @ np.array(ax_s)
        k = (TAG.get(tag, np.zeros(n)) * smooth((t + 0.01) / 0.08))[:, None]
        out = out * (1 - k) + mapped * k
        print('SLEEVE', sd, 'axis', [round(x, 2) for x in ax_s], '→', [round(x, 2) for x in ax_b], 'scale', round(s, 3))

elif KIND == 'boots':
    out = V.copy()
    under_legs = under_all
    for tag, sd in (('bootA', 'Left'), ('bootB', 'Right')):
        S = HI[tag]
        sole = S[S[:, 2] < 0.05]
        heel_x, toe_x = np.percentile(sole[:, 0], 99.7), np.percentile(sole[:, 0], 0.3)
        cy = (np.percentile(sole[:, 1], 2) + np.percentile(sole[:, 1], 98)) / 2
        Hs = np.array([heel_x, cy, S[:, 2].min()])
        sgn = 1 if sd == 'Left' else -1
        foot = leg_pts[sgn][leg_pts[sgn][:, 2] < P[sd + 'Foot'].z + 0.01]
        f = P[sd + 'Toe_End'] - P[sd + 'Foot']
        f.z = 0
        f.normalize()
        along = foot[:, :2] @ np.array(f.xy)
        side = np.array((f.y, -f.x))
        lat = foot[:, :2] @ side
        Lb = np.percentile(along, 99.5) - np.percentile(along, 0.5)
        s = (Lb + 0.024) / (heel_x - toe_x)
        heel_b = (np.percentile(along, 0.5) - 0.009) * np.array(f.xy) + (np.percentile(lat, 2) + np.percentile(lat, 98)) / 2 * side
        Hb = np.array([heel_b[0], heel_b[1], foot[:, 2].min() - 0.002])
        th = math.atan2(f.y, f.x) - math.pi        # the sculpt's toes point along -x
        Rz = np.array(Matrix.Rotation(th, 3, 'Z'))
        place = lambda X: Hb + ((X - Hs) * s) @ Rz.T
        mine = TAG.get(tag, np.zeros(n)) > 0.5
        SIDE[mine], K_SIDE[mine] = sgn, 1.0
        Vb = place(V[mine])
        # the shaft: centred on the leg (and the pants on it), widened to take it, above the ankle
        ank = P[sd + 'Foot'].z
        Sb = place(S)
        legp = np.concatenate([leg_pts[sgn], under_legs[under_side == sgn]])
        legp = legp[(legp[:, 2] > ank - 0.02) & (legp[:, 2] < Sb[:, 2].max() + 0.03)]
        s_sh = Slices(Sb[Sb[:, 2] > ank - 0.02], ank - 0.02, Sb[:, 2].max(), 0.004, 0.004, sm_h=2.0)
        b_sh = Slices(legp, ank - 0.02, Sb[:, 2].max(), 0.004, 0.005, sm_h=2.0)
        cs, hs = s_sh.at(Vb[:, 2])
        cb, hb = b_sh.at(Vb[:, 2])
        k = smooth((Vb[:, 2] - ank - 0.01) / 0.04)[:, None]
        grow = np.maximum(1.0, (hb + CFG['margin'] + 0.004) / hs)
        xy = Vb[:, :2] + k * (cb - cs)
        cen = cs + k * (cb - cs)
        Vb[:, :2] = cen + (xy - cen) * (1 + k * (grow - 1))
        out[mine] = Vb
        print('BOOT', sd, 'foot len', round(Lb, 3), 'scale', round(s, 3), 'top', round(Vb[:, 2].max(), 3))

# ---- 4 out of the body and the layers under it
cols = [(bco, btri)] + under_tris
cco = np.concatenate([c for c, _ in cols])
off = np.cumsum([0] + [len(c) for c, _ in cols])[:-1]
ctri = np.concatenate([t + o for (_, t), o in zip(cols, off)])
col_bvh = {0: bvh_of(cco, ctri)[0]}
for sgn in (1, -1):  # a leg's cloth is kept out of its own leg, not the other one (the thighs touch)
    other = np.zeros(len(cco), bool)
    other[:len(bco)] = BSIDE == -sgn
    col_bvh[sgn] = bvh_of(cco, ctri, ~other)[0]
col_of = np.where(K_SIDE > 0.5, SIDE, 0).astype(int)
X = out


def vertex_normals(X):
    me = lo.data
    me.vertices.foreach_set('co', X.astype(np.float32).ravel())
    me.update()
    nn = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('normal', nn)
    return nn.reshape(-1, 3)


margin = CFG['margin']
for it in range(6):
    N = vertex_normals(X)
    push = np.zeros_like(X)
    hit = np.zeros(n, bool)
    for i in range(n):
        loc, nrm, _, _ = col_bvh[col_of[i]].find_nearest(Vector(X[i]))
        if loc is None:
            continue
        d = X[i] - np.array(loc)
        nv = np.array(nrm)
        out_facing = N[i] @ nv > -0.2           # an inner wall (facing the body) only needs to clear it a little
        m = margin if out_facing else margin * 0.4
        sd_ = d @ nv
        if sd_ < m:
            push[i] = nv * (m - sd_)
            hit[i] = True
    print('PUSH', it, int(hit.sum()), 'verts')
    if not hit.any():
        break
    X = X + push
    if it < 5:  # spread the push a little, so pushed patches don't crease
        X = X + 0.5 * neighbour_mean(push) * (~hit)[:, None]
lo.data.vertices.foreach_set('co', X.astype(np.float32).ravel())
lo.data.update()

# ---- 5 skin: weights from the nearest point on the body
trunk_bvh, trunk_t = bvh_of(bco, btri, torso_v)
arm_bvh = {sd: bvh_of(bco, btri, side_arm_v[sd]) for sd in ('Left', 'Right')}


def nearest_w(bvh_t, p):
    bvh, t = bvh_t
    loc, _, fi, _ = bvh.find_nearest(Vector(p))
    a, b, c = (bco[j] for j in t[fi])
    v0, v1, v2 = b - a, c - a, np.array(loc) - a
    d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
    den = max(d00 * d11 - d01 * d01, 1e-12)
    wb = (d11 * d20 - d01 * d21) / den
    wc = (d00 * d21 - d01 * d20) / den
    bary = np.clip([1 - wb - wc, wb, wc], 0, 1)
    bary /= bary.sum()
    return bary @ BW[t[fi]]


W = np.array([nearest_w((trunk_bvh, trunk_t), p) for p in X])
leg_bvh = {}
for sgn in (1, -1):  # a leg's cloth takes its weights from that leg alone, never the other one
    leg_bvh[sgn] = bvh_of(bco, btri, torso_v & (BSIDE == sgn))
    for i in np.nonzero((SIDE == sgn) & (K_SIDE > 1e-3))[0]:
        W[i] = W[i] * (1 - K_SIDE[i]) + nearest_w(leg_bvh[sgn], X[i]) * K_SIDE[i]
for tag, sd in (('sleeveL', 'Left'), ('sleeveR', 'Right')):
    if tag in TAG and KIND == 'tunic':
        J = P[sd + 'Arm']
        k = TAG[tag] * smooth(((X - np.array(J)) @ np.array((P[sd + 'ForeArm'] - J).normalized()) + 0.005) / 0.03)
        for i in np.nonzero(k > 1e-3)[0]:
            W[i] = W[i] * (1 - k[i]) + nearest_w(arm_bvh[sd], X[i]) * k[i]
if KIND == 'tunic':  # the skirt rides the hips half way, rather than stretching between the thighs
    h = 0.55 * smooth((crotch_b + 0.04 - X[:, 2]) / 0.07)
    hipw = np.zeros(len(gnames)); hipw[gi['mixamorig:Hips']] = 1
    W = W * (1 - h)[:, None] + hipw * h[:, None]
for _ in range(2):
    W = 0.5 * W + 0.5 * neighbour_mean(W)
for sgn, other in ((1, 'Right'), (-1, 'Left')):  # and nothing of the other leg survives the smoothing
    cut = [i for i, nm in enumerate(short) if nm.startswith(other) and ('Leg' in nm or 'Foot' in nm or 'Toe' in nm)]
    rows = (SIDE == sgn) & (K_SIDE > 1e-3)
    W[np.ix_(rows, cut)] = 0
    for i in np.nonzero(rows & (W.sum(1) < 0.2))[0]:  # all of it was the other leg's: take its own
        W[i] = nearest_w(leg_bvh[sgn], X[i])
top = np.argsort(-W, 1)[:, :4]  # glTF / three.js keep 4 bones per vertex
W4 = np.zeros_like(W)
np.put_along_axis(W4, top, np.take_along_axis(W, top, 1), 1)
W4[W4 < 1e-3] = 0
W4 /= np.maximum(W4.sum(1, keepdims=True), 1e-9)

# ---- 5b the body under it: vertices well inside the garment (a ray straight out of the skin meets
# it), less a margin round the edges. glbhero.js leaves the body's triangles there undrawn while
# this is worn, so skin can't show through where the cloth runs close (inner thighs, armpits, feet)
gtri = np.array([tuple(p.vertices) for p in lo.data.polygons])
g_bvh = BVHTree.FromPolygons([Vector(p) for p in X], [tuple(t) for t in gtri])
cov = np.zeros(len(bco), bool)
for i, (p, nv) in enumerate(zip(bco, bnrm)):
    hit = g_bvh.ray_cast(Vector(p + nv * 1e-4), Vector(nv), 0.06)
    cov[i] = hit[0] is not None
BE = np.concatenate([btri[:, [0, 1]], btri[:, [1, 2]], btri[:, [2, 0]]])
for _ in range(2):  # erode: keep only vertices whose every neighbour is covered too
    bad = ~cov
    nb_bad = np.zeros(len(bco), bool)
    nb_bad[BE[bad[BE[:, 1]], 0]] = True
    nb_bad[BE[bad[BE[:, 0]], 1]] = True
    cov &= ~nb_bad
if KIND == 'boots':  # the whole foot is in the boot: none of it shows through a seam
    ank = (P['LeftFoot'].z + P['RightFoot'].z) / 2
    cov |= (BSIDE != 0) & (bco[:, 2] < ank + 0.01)
lo['hide_body'] = [int(i) for i in np.nonzero(cov)[0]]
lo['hide_body_of'] = len(bco)  # the body's vertex count, so a different body is never cut
print('HIDES', int(cov.sum()), 'of', len(bco), 'body verts')

# ---- 6 un-skin to the bind pose, bind, export
skin = [arm.matrix_world @ arm.pose.bones[g].matrix @ arm.pose.bones[g].bone.matrix_local.inverted() @ arm.matrix_world.inverted()
        if g in arm.pose.bones else Matrix.Identity(4) for g in gnames]
skin = np.array([np.array(m) for m in skin])
Mv = np.einsum('vg,gij->vij', W4, skin)
Xh = np.column_stack([X, np.ones(n)])
rest = np.einsum('vij,vj->vi', np.linalg.inv(Mv), Xh)[:, :3]
lo.data.vertices.foreach_set('co', rest.astype(np.float32).ravel())
lo.data.update()
used = np.nonzero(W4.sum(0) > 0)[0]
for g in used:
    vg = lo.vertex_groups.new(name=gnames[g])
    for i in np.nonzero(W4[:, g])[0]:
        vg.add([int(i)], float(W4[i, g]), 'REPLACE')
lo.parent = arm
lo.matrix_parent_inverse = arm.matrix_world.inverted()
mod = lo.modifiers.new('arm', 'ARMATURE')
mod.object = arm
mat.use_backface_culling = False  # through a gap you see the inside of the cloth, not the scene
for pb in arm.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
arm.animation_data_clear()
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
bpy.data.objects.remove(body, do_unlink=True)
for o in bpy.data.objects:
    o.select_set(o in (arm, lo))
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animations=False,
                          export_skins=True, export_apply=True, export_extras=True, export_image_format='JPEG', export_jpeg_quality=88)
print('WROTE', OUT, len(lo.data.polygons), 'tris,', len(used), 'bones')
