"""Turn a static Tripo clothing model into skinned gear for a Mixamo-rigged hero.

    blender -b --python tools/blender/cloak_gear.py -- \\
        game/assets/characterart/human.glb "game/assets/3ditems/green hooded cloak 3d model.glb" \\
        game/assets/3ditems/green_cloak.glb

The clothing was sculpted for an arms-down stance, but the body's rest (bind) pose is a T-pose. So
everything is fitted against the body in its idle pose, then un-skinned back to the bind pose:

  1 join the clothing parts and decimate (the Tripo export is ~1.9M triangles) to TRIS
  2 pose the body in idle frame 0 and fit the clothing to that shape:
      a place + size it: search an offset and horizontal scale, scored by rays from the body
        (torso: forward and back must hit cloth; head: back, up and the sides must hit the hood)
      b ease the hood back and up so its rim frames the face
      c cover the silhouette: between hips and neck, move cloth that lies inside the body's reach
        (arms included) out past it (a broader body than the sculpt pokes out of gaps otherwise)
      d push any cloth still inside / too close to the skin out to MARGIN
  3 skin it: weights from the nearest point on the posed body, arm weights cut to ARM_KEEP, and
    the back and sides below the shoulder blades on spring strands (cape_<c>_<k> off Spine2) that
    glbhero.js simulates; the front skirt follows the legs half way
  4 un-skin: move every vertex to where the skeleton's idle pose will carry it back to the fit
  5 export the armature (with strands, in its rest pose) and the clothing only, textures ≤ TEX px

glbhero.js attaches the result to a hero with the same skeleton (loadGlbGear / look.wear).
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:]
BODY, CLOTH, OUT = argv[0], argv[1], argv[2]
TRIS = 40000      # triangle budget for the clothing
MARGIN = 0.012    # gap kept between cloth and skin (model units; the body is ~1 tall)
COVER = 0.02      # gap kept outside the body's silhouette between hips and neck
ARM_KEEP = 0.35   # share of arm weights the cloth keeps
HOOD_BACK, HOOD_UP = 0.05, 0.015
# the face window cut into the hood's dark fill (brow → chin keeps the brim over the forehead)
FACE_TOP, FACE_BOT, FACE_W, FACE_R = 0.072, -0.06, 0.062, 0.17  # brow and chin, from the Head bone
COLS = [-105, -55, 0, 55, 105]  # strand angles round the body, 0 = straight behind
SEGS = 4
TEX = 1024


def clamp01(x):
    return min(1.0, max(0.0, x))


def smooth(x):
    x = clamp01(x)
    return x * x * (3 - 2 * x)


bpy.ops.wm.read_factory_settings(use_empty=True)

# ---- 1 the clothing, joined and decimated
bpy.ops.import_scene.gltf(filepath=CLOTH)
parts = [o for o in bpy.data.objects if o.type == 'MESH']
for o in bpy.data.objects:
    o.select_set(o in parts)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.join()
cloth = bpy.context.view_layer.objects.active
cloth.name = 'cloak'
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(bpy.data.objects):
    if o != cloth:
        bpy.data.objects.remove(o, do_unlink=True)
tris0 = sum(len(p.vertices) - 2 for p in cloth.data.polygons)
dec = cloth.modifiers.new('dec', 'DECIMATE')
dec.ratio = min(1.0, TRIS / max(1, tris0))
bpy.ops.object.modifier_apply(modifier='dec')
print(f'DECIMATED {tris0} -> {sum(len(p.vertices) - 2 for p in cloth.data.polygons)} tris, {len(cloth.data.vertices)} verts')

# ---- 2 the body, posed in idle frame 0
bpy.ops.import_scene.gltf(filepath=BODY)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
body = next(o for o in bpy.data.objects if o.type == 'MESH' and o != cloth and o.name != 'Icosphere')
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
POSE = {pb.name: (pb.location.copy(), pb.rotation_quaternion.copy(), pb.scale.copy()) for pb in arm.pose.bones}
dg = bpy.context.evaluated_depsgraph_get()
bev = body.evaluated_get(dg)
bme = bev.to_mesh()
bw = body.matrix_world
bverts = [bw @ v.co for v in bme.vertices]  # same order as the base mesh
bpolys = [list(p.vertices) for p in bme.polygons]
bnorm = [(bw.to_3x3() @ p.normal).normalized() for p in bme.polygons]
bev.to_mesh_clear()
btree = BVHTree.FromPolygons(bverts, bpolys)


def bone_w(n):  # posed head of a bone, world space
    return arm.matrix_world @ arm.pose.bones['mixamorig:' + n].head


F = bone_w('LeftToeBase') - bone_w('LeftFoot')
F.z = 0
F.normalize()
R = bone_w('RightArm') - bone_w('LeftArm')
R.z = 0
R.normalize()
UP = Vector((0, 0, 1))
neck, hips, spine = bone_w('Neck'), bone_w('Hips'), bone_w('Spine1')
half = abs((bone_w('RightShoulder') - bone_w('LeftShoulder')).dot(R)) * 0.5 + 0.03

bm = bmesh.new()
bm.from_mesh(cloth.data)
bm.verts.ensure_lookup_table()
nbr = [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]
bm.free()
cw, cwi = cloth.matrix_world, cloth.matrix_world.inverted()


def get_pos():
    return [cw @ v.co for v in cloth.data.vertices]


def set_pos(pos):
    for v, p in zip(cloth.data.vertices, pos):
        v.co = cwi @ p


# ---- 2a place + size
pos = get_pos()
ctree = BVHTree.FromPolygons(pos, [list(p.vertices) for p in cloth.data.polygons])
centre = Vector((sum(p.x for p in pos) / len(pos), sum(p.y for p in pos) / len(pos), 0))
torso = [p for p in bverts[::3] if hips.z < p.z < neck.z and abs((p - neck).dot(R)) < half]
head = [p for p in bverts[::3] if p.z > neck.z + 0.03]


def score(off, sxy):
    def local(p):
        q = p - off - centre
        return Vector((q.x / sxy, q.y / sxy, q.z)) + centre
    hit = 0.0
    for p in torso:
        q = local(p)
        hit += sum(1 for d in (F, -F) if ctree.ray_cast(q, d, 0.4)[0] is not None) / 2
    for p in head:
        q = local(p)
        hit += sum(1 for d in (-F, UP, R, -R) if ctree.ray_cast(q, d, 0.3)[0] is not None) / 4
    return hit / (len(torso) + len(head))


best = None
for sxy in (1.0, 1.05, 1.1, 1.15, 1.2, 1.25):
    for fwd in (-0.09, -0.06, -0.03, 0.0, 0.03, 0.06):
        for side in (-0.02, 0.0, 0.02):
            off = F * fwd + R * side
            s_ = score(off, sxy)
            if best is None or s_ > best[0] + 0.01:
                best = (s_, off, sxy)
s_, off, sxy = best
print(f'FIT covers {s_:.2f} of body samples: forward {off.dot(F):+.3f} side {off.dot(R):+.3f} scale {sxy}')
# widen only where the body needs it: full scale from the chest up, none below the knees, so the
# hem keeps the sculpt's width instead of flaring into a bell
knee_z = bone_w('LeftLeg').z
def widen(z):
    return 1 + (sxy - 1) * smooth((z - knee_z) / max(1e-6, spine.z - knee_z))
pos = [Vector(((p - centre).x * widen(p.z), (p - centre).y * widen(p.z), p.z)) + Vector((centre.x, centre.y, 0)) + off for p in pos]

# ---- 2b hood back and up, fading in above the neck
pos = [p + (-F * HOOD_BACK + UP * HOOD_UP) * smooth((p.z - (neck.z + 0.02)) / 0.08) for p in pos]

# ---- 2c cover the silhouette (hips → neck), arms included
ABIN, ZBIN = 6, 0.025
axis = Vector((spine.x, spine.y, 0))
lo, hi = hips.z - 0.05, neck.z + 0.02
reach = {}
for p in bverts:
    if lo < p.z < hi:
        d = Vector((p.x, p.y, 0)) - axis
        k = (int(math.degrees(math.atan2(d.y, d.x)) // ABIN), int(p.z // ZBIN))
        reach[k] = max(reach.get(k, 0), d.length)
disp = [Vector() for _ in pos]
covered = 0
for i, p in enumerate(pos):
    if not (lo < p.z < hi):
        continue
    d = Vector((p.x, p.y, 0)) - axis
    r = d.length
    if r < 1e-4:
        continue
    a, z = int(math.degrees(math.atan2(d.y, d.x)) // ABIN), int(p.z // ZBIN)
    need = max((reach.get((a + da, z + dz), 0) for da in (-1, 0, 1) for dz in (-1, 0, 1)), default=0)
    if need and r < need + COVER:
        k = clamp01(min((p.z - lo) / 0.08, (hi - p.z) / 0.05))
        disp[i] = d.normalized() * (need + COVER - r) * k
        covered += 1
for _ in range(5):
    disp = [max([disp[i]] + [disp[j] * 0.8 for j in nbr[i]], key=lambda x: x.length) for i in range(len(disp))]
pos = [p + d for p, d in zip(pos, disp)]
print('COVER', covered, 'verts were inside the silhouette')

# ---- 2d push out of the skin
for it in range(20):
    push = {}
    for i, p in enumerate(pos):
        hit, n, fi, d = btree.find_nearest(p, 0.3)
        if hit is None:
            continue
        depth = (p - hit).dot(bnorm[fi])
        if depth < MARGIN:
            push[i] = bnorm[fi] * (MARGIN - depth)
    if not push:
        print(f'PUSH clear after {it} passes')
        break
    disp = {i: v.copy() for i, v in push.items()}
    frontier, seen = list(push), set(push)
    for fade in (0.6, 0.35, 0.15):
        nxt = []
        for i in frontier:
            for j in nbr[i]:
                if j not in seen:
                    seen.add(j)
                    disp[j] = disp[i] * fade
                    nxt.append(j)
        frontier = nxt
    for i, d in disp.items():
        pos[i] = pos[i] + d
    if it in (0, 19):
        print(f'PUSH pass {it}: {len(push)} verts inside')

# ---- 2e open the hood: the sculpt fills the hood opening with a dark 'shadow face' surface. Cut
# away the cloth in front of the face (inside the opening, not the rim) so the hero's face shows.
head_c = bone_w('Head')
cut = set()
def in_window(p):
    d = p - head_c
    return d.dot(F) > 0.0 and abs(d.dot(R)) < FACE_W and FACE_BOT < d.z < FACE_TOP and d.length < FACE_R


for poly in cloth.data.polygons:  # any corner inside: big triangles otherwise leave shards
    if any(in_window(pos[i]) for i in poly.vertices):
        cut.add(poly.index)
if cut:
    bm = bmesh.new()
    bm.from_mesh(cloth.data)
    for v, p in zip(bm.verts, pos):
        v.co = cwi @ p
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in cut], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(cloth.data)
    bm.free()
    pos = get_pos()
    bm = bmesh.new()
    bm.from_mesh(cloth.data)
    bm.verts.ensure_lookup_table()
    nbr = [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]
    bm.free()
print('HOOD opened:', len(cut), 'faces cut from in front of the face')

# ---- 3 skin: weights from the nearest point on the posed body
gname = {g.index: g.name for g in body.vertex_groups}
bweights = [{gname[g.group]: g.weight for g in v.groups if g.weight > 0} for v in body.data.vertices]
spine2_z = bone_w('Spine2').z
transfer = []
for p in pos:
    hit, n, fi, d = btree.find_nearest(p)
    ws, tot = {}, 0.0
    for vi in bpolys[fi]:
        k = 1.0 / max(1e-5, (bverts[vi] - hit).length)
        tot += k
        for g, w in bweights[vi].items():
            ws[g] = ws.get(g, 0) + w * k
    ws = {g: w / tot for g, w in ws.items()}
    moved = 0.0
    for g in list(ws):
        if any(g.replace('mixamorig:', '').startswith(s + part) for s in ('Left', 'Right') for part in ('Arm', 'ForeArm', 'Hand')):
            moved += ws[g] * (1 - ARM_KEEP)
            ws[g] *= ARM_KEEP
    if moved:
        tgt = 'mixamorig:Spine2' if p.z > spine2_z else 'mixamorig:Spine1' if p.z > hips.z else 'mixamorig:Hips'
        ws[tgt] = ws.get(tgt, 0) + moved
    transfer.append(ws)


def angle_of(p):  # 0 behind, ±90 the sides, ±180 in front
    d = p - spine
    d.z = 0
    return math.degrees(math.atan2(d.dot(R), d.dot(-F)))


# strands: knots on the posed cloth, bones placed in rest space through Spine2's idle pose
top_z = spine2_z
fade_z = top_z - 0.2 * top_z
pb_sp = arm.pose.bones['mixamorig:Spine2']
sp_skin = arm.matrix_world @ pb_sp.matrix @ pb_sp.bone.matrix_local.inverted() @ arm.matrix_world.inverted()
to_rest = arm.matrix_world.inverted() @ sp_skin.inverted()  # posed world → armature rest space
info = [(i, p, angle_of(p)) for i, p in enumerate(pos)]
knots_all = []
for ca in COLS:
    pts = [p for i, p, a in info if abs(a - ca) < 22 and p.z < top_z + 0.02]
    zs = sorted(p.z for p in pts)
    zt, zb = top_z, zs[int(len(zs) * 0.02)]
    knots = []
    for k in range(SEGS + 1):
        lvl = zt + (zb - zt) * k / SEGS
        sel = [p for p in pts if abs(p.z - lvl) < (zt - zb) / SEGS * 0.6]
        sel = sorted(sel, key=lambda p: -((p - spine) * Vector((1, 1, 0))).length)[:max(3, len(sel) // 4)] or pts
        knots.append(sum(sel, Vector()) / len(sel))
    knots_all.append((ca, zt, zb, knots))

bpy.context.view_layer.objects.active = arm
for o in bpy.data.objects:
    o.select_set(o == arm)
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
chains = []
for c, (ca, zt, zb, knots) in enumerate(knots_all):
    parent, names = eb['mixamorig:Spine2'], []
    for k in range(SEGS + 1):
        b = eb.new(f'cape_{c}_{k}' if k < SEGS else f'cape_{c}_end')
        tail = knots[k + 1] if k < SEGS else knots[k] + (knots[k] - knots[k - 1]) * 0.3
        b.head, b.tail = to_rest @ knots[k], to_rest @ tail
        b.parent = parent
        b.use_connect = False
        b.use_deform = k < SEGS
        parent = b
        names.append(b.name)
    chains.append({'ang': ca, 'top': zt, 'bot': zb, 'names': names[:-1]})
bpy.ops.object.mode_set(mode='OBJECT')

step = COLS[1] - COLS[0]
final_w = []
for i, p, a in info:
    back = clamp01((abs(COLS[-1]) + 10 - abs(a)) / 25)  # 1 across the back and sides, 0 in front
    f = back * smooth((top_z - p.z) / max(1e-6, top_z - fade_z))
    final = {g: w * (1 - f) for g, w in transfer[i].items()}
    if f > 0:
        cw_ = [max(0.0, 1 - abs(a - ch['ang']) / step) for ch in chains]
        if sum(cw_) < 1e-6:
            cw_[min(range(len(chains)), key=lambda c: abs(a - chains[c]['ang']))] = 1
        t = sum(cw_)
        for ch, w0 in zip(chains, cw_):
            if w0 <= 0:
                continue
            u = clamp01((ch['top'] - p.z) / max(1e-6, ch['top'] - ch['bot'])) * SEGS
            ws = [max(0.0, 1 - abs(u - (k + 0.5))) for k in range(SEGS)]
            if u < 0.5:
                ws[0] = 1.0
            if u > SEGS - 0.5:
                ws[-1] = 1.0
            s = sum(ws)
            for k, wk in enumerate(ws):
                if wk > 0:
                    n = ch['names'][k]
                    final[n] = final.get(n, 0) + f * w0 / t * wk / s
    if back < 1 and p.z < hips.z:  # front skirt: legs only half way, the rest on the hips
        legs = sum(w for g, w in final.items() if 'Leg' in g)
        if legs:
            for g in list(final):
                if 'Leg' in g:
                    final[g] *= 0.5
            final['mixamorig:Hips'] = final.get('mixamorig:Hips', 0) + legs * 0.5
    tot = sum(final.values()) or 1
    final_w.append({g: w / tot for g, w in final.items() if w / tot > 1e-3})
print('SKINNED', len(info), 'verts;', len(chains), 'strands at', COLS)

# ---- 4 un-skin: rest position = (blend of the bones' idle skin matrices)^-1 · fitted position
arm.animation_data.action = idle
sc.frame_set(int(idle.frame_range[0]))
bpy.context.view_layer.update()
skin = {pb.name: arm.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted() @ arm.matrix_world.inverted()
        for pb in arm.pose.bones}
rest = []
for p, ws in zip(pos, final_w):
    M = Matrix.Diagonal((0, 0, 0, 0))
    for g, w in ws.items():
        M = M + skin[g] * w
    rest.append(M.inverted_safe() @ p)
set_pos(rest)
cloth.vertex_groups.clear()
vgs = {}
for i, ws in enumerate(final_w):
    for g, w in ws.items():
        if g not in vgs:
            vgs[g] = cloth.vertex_groups.new(name=g)
        vgs[g].add([i], w, 'REPLACE')
print('UNSKINNED to the bind pose')

# ---- 5 bind, drop the body, rest pose, export
arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.location, pb.rotation_quaternion, pb.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
cloth.parent = arm
mod = cloth.modifiers.new('arm', 'ARMATURE')
mod.object = arm
bpy.data.objects.remove(body, do_unlink=True)
for img in bpy.data.images:
    if img.size[0] > TEX:
        img.scale(TEX, int(img.size[1] * TEX / img.size[0]))
for o in bpy.data.objects:
    o.select_set(o in (arm, cloth))
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_animations=False,
                          export_skins=True, export_image_format='JPEG', export_jpeg_quality=85)
print('WROTE', OUT)
