"""Bake game-ready clips for a Tripo Mixamo-rigged character.

    blender -b --python tools/blender/rogue_anims.py -- game/assets/characterart/rouge.glb game/assets/characterart/rogue.glb
    blender -b --python tools/blender/rogue_anims.py -- game/assets/characterart/human.glb game/assets/characterart/human_game.glb

The profile (third argument, else from the file name) picks the trims and whether the rogue's
outfit fixes run (cape bones, back pieces). The hand-keyed moves are shared: same rig.

The Tripo export ships long Mixamo mocap: a 6.6 s two-handed wood chop, a boxing combo, a jump
*off a ledge* whose hips drop a body height below the feet. None of it reads as a game move, so:

  idle, walk, run         kept (run's hips slid back over the feet)
  hit, hit2, knockdown    trimmed from hit_to_body_01 / hit_to_side / fall (faint)
  cheer, bow, fold        trimmed from agree / bow / fold_arms (fold in, hold, unfold)
  slash, slash2, slash3   hand-keyed sword combo: diagonal → backhand → overhead
  punch, punch2, kick     hand-keyed unarmed combo: jab → left cross (mirrored jab) → front kick
  slashL, punchL          mirrored for left-hand attacks
  jump, fall, land        hand-keyed air: knee-up take-off → tuck → legs reaching down → crouch
  victory, wave           hand-keyed emotes
  look, stretch           hand-keyed idle fidgets

Hand-keyed poses start from idle's first frame and add swings, given in the character's own
frame (F forward, R right, U up), so they don't depend on the rig's bone axes. Each key is
a list of ops:
  ('swing', bone, toward, deg)  rotate the bone (and its children) by deg toward a direction
  ('turn',  bone, axis, deg)    rotate the bone about an axis (right-hand rule: +U turns left,
                                +F rolls the top to the right, +R tips the top back)
  ('drop',  'Hips', '', frac)   lower the hips by frac of the body height (crouches)
MIRROR builds a clip as the left/right reflection of another.
Directions are strings like 'F', '-U', 'F+U', 'R-F'. Clips glbhero.js scrubs by progress
(punch, slash, jump, fall), so key spacing sets the feel: slow wind-up, snap, ease out.
Check the result with game/world3d/anim-lab.html.
"""
import math
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
# Which character: 'rogue' (cape + outfit fixes) or 'human' (a plain base body). From the file name
# unless given as a third argument.
PROFILE = argv[2] if len(argv) > 2 else ('rogue' if any(k in SRC.lower() for k in ('rogue', 'rouge')) else 'human')
FPS = 24

# name: (source clip, [(start s, end s) | ('hold', s)], slide hips back over the feet)
TRIMS = {
    'rogue': {
        'hit': ('hit_to_body_01', [(0.00, 0.90)], False),
        'hit2': ('hit_to_side', [(0.00, 0.95)], False),
        'knockdown': ('fall', [(0.80, 2.40)], False),  # from the stagger into the fall: a faint is short
        'cheer': ('agree', [(0.00, 2.00)], False),
        'bow': ('bow', [(1.70, 4.40)], True),
        'fold': ('fold_arms', [(0.30, 2.60), ('hold', 2.5), (15.20, 17.08)], True),
    },
    'human': {
        'hit': ('hit_to_body_01', [(0.00, 0.90)], False),
        'hit2': ('hit_to_side', [(0.00, 0.95)], False),
        'knockdown': ('fall', [(0.80, 2.40)], False),
        'cheer': ('agree', [(0.00, 2.00)], False),
    },
}
TRIM = TRIMS[PROFILE]
KEEP = ['idle', 'walk', 'run']

# frame: ops. Arms start hanging at the sides (idle).
KEYED = {
    # One-handed sword slash, right to left across the body.
    'slash': {
        0: [],
        3: [  # lift: elbow comes up in front, hand rising
            ('turn', 'Spine1', 'U', -6), ('turn', 'Spine2', 'U', -6),
            ('swing', 'RightArm', 'F+R*0.6', 70), ('swing', 'RightForeArm', 'U', 70),
            ('swing', 'LeftArm', 'F+R*0.3', 25), ('swing', 'LeftForeArm', 'U+F', 35),
        ],
        6: [  # wind-up: hand by the right ear, blade laid back over the shoulder, chest turned right
            ('turn', 'Spine1', 'U', -16), ('turn', 'Spine2', 'U', -14), ('swing', 'Spine2', '-F', 5),
            ('swing', 'RightArm', 'R+U*0.7', 105), ('swing', 'RightForeArm', 'U-R*0.5', 105),
            ('swing', 'RightHand', '-F', 30),
            ('swing', 'LeftArm', 'F+R*0.5', 50), ('swing', 'LeftForeArm', 'U+F', 50),
        ],
        9: [  # strike: arm whips across to the left, chest turned through, leaning in
            ('turn', 'Spine1', 'U', 16), ('turn', 'Spine2', 'U', 16), ('swing', 'Spine1', 'F', 10),
            ('swing', 'RightArm', 'F-R*0.6', 80), ('swing', 'RightForeArm', 'F', 10),
            ('swing', 'RightHand', '-R', 15),
            ('swing', 'LeftArm', '-F-R*0.3', 35), ('swing', 'LeftForeArm', 'U+F', 40),
        ],
        12: [  # follow-through: low on the left, still turned
            ('turn', 'Spine1', 'U', 20), ('turn', 'Spine2', 'U', 14), ('swing', 'Spine1', 'F', 8),
            ('swing', 'RightArm', 'F-R', 55), ('swing', 'RightForeArm', 'F-R', 20),
            ('swing', 'LeftArm', '-F', 25), ('swing', 'LeftForeArm', 'U+F', 35),
        ],
        17: [  # settle back toward the hanging arms
            ('turn', 'Spine1', 'U', 4),
            ('swing', 'RightArm', 'F', 15), ('swing', 'RightForeArm', 'F+U', 25),
        ],
    },
    # Right straight punch: guard up, cock back, snap to full reach, recoil.
    'punch': {
        0: [],
        4: [  # guard + cock: elbow back, fist by the chin, chest turned right
            ('turn', 'Spine1', 'U', -12), ('turn', 'Spine2', 'U', -10),
            ('swing', 'RightArm', '-F+R*0.4', 30), ('swing', 'RightForeArm', 'U+F', 135),
            ('swing', 'LeftArm', 'F+R*0.4', 40), ('swing', 'LeftForeArm', 'U+F', 115),
        ],
        7: [  # impact: arm straight out at shoulder height, shoulder and chest driven through
            ('turn', 'Spine1', 'U', 14), ('turn', 'Spine2', 'U', 12), ('swing', 'Spine1', 'F', 8),
            ('swing', 'RightShoulder', 'F', 12),
            ('swing', 'RightArm', 'F-R*0.15', 88), ('swing', 'RightForeArm', 'F', 3),
            ('swing', 'LeftArm', 'F+R*0.4', 40), ('swing', 'LeftForeArm', 'U+F', 120),
        ],
        9: [  # hold a beat at reach
            ('turn', 'Spine1', 'U', 12), ('turn', 'Spine2', 'U', 10), ('swing', 'Spine1', 'F', 6),
            ('swing', 'RightShoulder', 'F', 8),
            ('swing', 'RightArm', 'F-R*0.15', 82), ('swing', 'RightForeArm', 'U+F', 15),
            ('swing', 'LeftArm', 'F+R*0.4', 40), ('swing', 'LeftForeArm', 'U+F', 115),
        ],
        15: [  # recoil toward hanging arms
            ('swing', 'RightArm', 'F', 20), ('swing', 'RightForeArm', 'U+F', 40),
            ('swing', 'LeftArm', 'F', 15), ('swing', 'LeftForeArm', 'U+F', 30),
        ],
    },
    # Take-off (scrubbed by upward speed): right knee drives up, left leg trails, arms swing up.
    'jump': {
        0: [  # push-off
            ('swing', 'Spine', 'F', 8),
            ('swing', 'RightUpLeg', 'F', 35), ('swing', 'RightLeg', '-F', 45),
            ('swing', 'LeftUpLeg', '-F', 20), ('swing', 'LeftLeg', '-F', 25), ('swing', 'LeftFoot', '-U', 25),
            ('swing', 'LeftArm', 'F+R*0.3', 55), ('swing', 'LeftForeArm', 'U+F', 40),
            ('swing', 'RightArm', '-F', 30), ('swing', 'RightForeArm', 'U+F', 30),
        ],
        6: [  # rising: knee high, trailing leg folding under
            ('swing', 'Spine', 'F', 6),
            ('swing', 'RightUpLeg', 'F', 70), ('swing', 'RightLeg', '-F', 95),
            ('swing', 'LeftUpLeg', 'F', 10), ('swing', 'LeftLeg', '-F', 70), ('swing', 'LeftFoot', '-U', 20),
            ('swing', 'LeftArm', 'F+U*0.2', 75), ('swing', 'LeftForeArm', 'U+F', 35),
            ('swing', 'RightArm', '-R', 40), ('swing', 'RightForeArm', 'U+F', 30),
        ],
        10: [  # apex: compact tuck, arms out for balance
            ('swing', 'Spine', 'F', 10),
            ('swing', 'RightUpLeg', 'F', 65), ('swing', 'RightLeg', '-F', 100),
            ('swing', 'LeftUpLeg', 'F', 45), ('swing', 'LeftLeg', '-F', 95),
            ('swing', 'LeftArm', '-R-F*0.2', 55), ('swing', 'LeftForeArm', 'U', 25),
            ('swing', 'RightArm', 'R-F*0.2', 55), ('swing', 'RightForeArm', 'U', 25),
        ],
    },
    # Falling (scrubbed by downward speed): the tuck opens and the legs reach for the ground.
    'fall': {
        0: [  # = jump's apex
            ('swing', 'Spine', 'F', 10),
            ('swing', 'RightUpLeg', 'F', 65), ('swing', 'RightLeg', '-F', 100),
            ('swing', 'LeftUpLeg', 'F', 45), ('swing', 'LeftLeg', '-F', 95),
            ('swing', 'LeftArm', '-R-F*0.2', 55), ('swing', 'LeftForeArm', 'U', 25),
            ('swing', 'RightArm', 'R-F*0.2', 55), ('swing', 'RightForeArm', 'U', 25),
        ],
        8: [  # legs down, knees soft, arms up and out
            ('swing', 'Spine', 'F', 6),
            ('swing', 'RightUpLeg', 'F', 25), ('swing', 'RightLeg', '-F', 35),
            ('swing', 'LeftUpLeg', 'F', 10), ('swing', 'LeftLeg', '-F', 25),
            ('swing', 'LeftArm', '-R-F*0.1+U*0.3', 62), ('swing', 'LeftForeArm', 'U', 20),
            ('swing', 'RightArm', 'R-F*0.1+U*0.3', 62), ('swing', 'RightForeArm', 'U', 20),
        ],
    },

    # Sword combo 2: backhand, from across the body out to the right.
    'slash2': {
        0: [],
        4: [  # coil: blade carried across to the left shoulder, chest turned left
            ('turn', 'Spine1', 'U', 16), ('turn', 'Spine2', 'U', 12),
            ('swing', 'RightArm', 'F-R', 75), ('swing', 'RightForeArm', 'U-R*0.6', 70),
            ('swing', 'LeftArm', '-F', 20),
        ],
        7: [  # strike: arm flung out flat to the right, chest unwinding hard
            ('turn', 'Spine1', 'U', -18), ('turn', 'Spine2', 'U', -14), ('swing', 'Spine1', 'F', 6),
            ('swing', 'RightArm', 'R+F*0.6', 85), ('swing', 'RightForeArm', 'R', 5),
            ('swing', 'LeftArm', '-R+F*0.3', 35), ('swing', 'LeftForeArm', 'U+F', 40),
        ],
        10: [  # follow-through: swept round behind on the right
            ('turn', 'Spine1', 'U', -22), ('turn', 'Spine2', 'U', -14),
            ('swing', 'RightArm', 'R-F*0.4', 75), ('swing', 'RightForeArm', 'U', 20),
            ('swing', 'LeftArm', '-R+F*0.3', 30), ('swing', 'LeftForeArm', 'U+F', 35),
        ],
        16: [('swing', 'RightArm', 'R', 20), ('swing', 'RightForeArm', 'U+F', 25)],
    },
    # Sword combo 3: overhead finisher, straight down, leaning into it.
    'slash3': {
        0: [],
        5: [  # raise: blade straight up and back, body arched, left hand up for balance
            ('swing', 'Spine2', '-F', 8),
            ('swing', 'RightArm', 'U-F*0.15', 160), ('swing', 'RightForeArm', '-F', 40),
            ('swing', 'LeftArm', 'F+U*0.5', 70), ('swing', 'LeftForeArm', 'U', 40),
        ],
        8: [  # chop: arm drives down in front, chest folds over it
            ('swing', 'Spine', 'F', 12), ('swing', 'Spine1', 'F', 14),
            ('swing', 'RightArm', 'F-U*0.3', 70), ('swing', 'RightForeArm', 'F', 5),
            ('swing', 'LeftArm', '-F', 30),
        ],
        11: [  # hold low
            ('swing', 'Spine', 'F', 10), ('swing', 'Spine1', 'F', 12),
            ('swing', 'RightArm', 'F-U*0.5', 55), ('swing', 'RightForeArm', 'F', 10),
            ('swing', 'LeftArm', '-F', 25),
        ],
        18: [('swing', 'RightArm', 'F', 15), ('swing', 'RightForeArm', 'F+U', 25)],
    },
    # Unarmed combo 3: front kick (a full-body clip: it takes the legs too).
    'kick': {
        0: [],
        3: [  # chamber: knee up and folded, leaning back, fists up
            ('swing', 'Spine', '-F', 8),
            ('swing', 'RightUpLeg', 'F', 85), ('swing', 'RightLeg', '-F', 110), ('swing', 'LeftLeg', '-F', 10),
            ('swing', 'RightArm', '-F+R*0.4', 30), ('swing', 'RightForeArm', 'U+F', 130),
            ('swing', 'LeftArm', 'F+R*0.4', 40), ('swing', 'LeftForeArm', 'U+F', 115),
        ],
        6: [  # snap: leg straight out, body counter-leaning
            ('swing', 'Spine', '-F', 15),
            ('swing', 'RightUpLeg', 'F', 95), ('swing', 'RightLeg', '-F', 5), ('swing', 'LeftLeg', '-F', 12),
            ('swing', 'RightArm', '-F+R*0.4', 35), ('swing', 'RightForeArm', 'U+F', 120),
            ('swing', 'LeftArm', 'F+R*0.4', 40), ('swing', 'LeftForeArm', 'U+F', 115),
        ],
        8: [
            ('swing', 'Spine', '-F', 14),
            ('swing', 'RightUpLeg', 'F', 90), ('swing', 'RightLeg', '-F', 10), ('swing', 'LeftLeg', '-F', 12),
            ('swing', 'RightArm', '-F+R*0.4', 35), ('swing', 'RightForeArm', 'U+F', 120),
            ('swing', 'LeftArm', 'F+R*0.4', 40), ('swing', 'LeftForeArm', 'U+F', 115),
        ],
        11: [  # re-chamber
            ('swing', 'Spine', '-F', 6),
            ('swing', 'RightUpLeg', 'F', 70), ('swing', 'RightLeg', '-F', 100),
            ('swing', 'RightArm', '-F+R*0.4', 25), ('swing', 'RightForeArm', 'U+F', 110),
            ('swing', 'LeftArm', 'F+R*0.4', 30), ('swing', 'LeftForeArm', 'U+F', 100),
        ],
        16: [],
    },
    # Landing crouch (full body, played on touch-down, scaled by how hard you land).
    'land': {
        0: [
            ('drop', 'Hips', '', 0.16), ('swing', 'Spine', 'F', 14), ('swing', 'Spine1', 'F', 8),
            ('swing', 'LeftUpLeg', 'F', 50), ('swing', 'LeftLeg', '-F', 85), ('swing', 'LeftFoot', 'F', 35),
            ('swing', 'RightUpLeg', 'F', 44), ('swing', 'RightLeg', '-F', 70), ('swing', 'RightFoot', 'F', 28),
            ('swing', 'LeftArm', 'F-R*0.4', 30), ('swing', 'LeftForeArm', 'U+F', 25),
            ('swing', 'RightArm', 'F+R*0.4', 30), ('swing', 'RightForeArm', 'U+F', 25),
        ],
        4: [
            ('drop', 'Hips', '', 0.05), ('swing', 'Spine', 'F', 7),
            ('swing', 'LeftUpLeg', 'F', 25), ('swing', 'LeftLeg', '-F', 42), ('swing', 'LeftFoot', 'F', 17),
            ('swing', 'RightUpLeg', 'F', 20), ('swing', 'RightLeg', '-F', 30), ('swing', 'RightFoot', 'F', 12),
            ('swing', 'LeftArm', 'F-R*0.4', 15), ('swing', 'RightArm', 'F+R*0.4', 15),
        ],
        9: [],
    },
    # Emote: fist pump.
    'victory': {
        0: [],
        5: [('swing', 'Spine2', '-F', 6), ('swing', 'RightArm', 'U+R*0.2', 150), ('swing', 'RightForeArm', 'U-R', 40),
            ('swing', 'LeftArm', '-R', 20), ('swing', 'LeftForeArm', 'U+F', 80)],
        9: [('swing', 'Spine2', '-F', 4), ('swing', 'RightArm', 'U+R*0.2', 135), ('swing', 'RightForeArm', 'U-R', 75),
            ('swing', 'LeftArm', '-R', 20), ('swing', 'LeftForeArm', 'U+F', 80)],
        13: [('swing', 'Spine2', '-F', 6), ('swing', 'RightArm', 'U+R*0.2', 150), ('swing', 'RightForeArm', 'U-R', 40),
             ('swing', 'LeftArm', '-R', 20), ('swing', 'LeftForeArm', 'U+F', 80)],
        17: [('swing', 'Spine2', '-F', 4), ('swing', 'RightArm', 'U+R*0.2', 135), ('swing', 'RightForeArm', 'U-R', 75),
             ('swing', 'LeftArm', '-R', 20), ('swing', 'LeftForeArm', 'U+F', 80)],
        26: [],
    },
    # Emote: wave.
    'wave': {
        0: [],
        5: [('swing', 'RightArm', 'R+U', 120), ('swing', 'RightForeArm', 'U', 60), ('turn', 'Head', 'U', -10)],
        9: [('swing', 'RightArm', 'R+U', 120), ('swing', 'RightForeArm', 'U', 60), ('turn', 'RightForeArm', 'F', 22), ('turn', 'Head', 'U', -10)],
        13: [('swing', 'RightArm', 'R+U', 120), ('swing', 'RightForeArm', 'U', 60), ('turn', 'RightForeArm', 'F', -22), ('turn', 'Head', 'U', -10)],
        17: [('swing', 'RightArm', 'R+U', 120), ('swing', 'RightForeArm', 'U', 60), ('turn', 'RightForeArm', 'F', 22), ('turn', 'Head', 'U', -10)],
        21: [('swing', 'RightArm', 'R+U', 120), ('swing', 'RightForeArm', 'U', 60), ('turn', 'RightForeArm', 'F', -22), ('turn', 'Head', 'U', -10)],
        28: [],
    },
    # Idle fidget: glance left, then right.
    'look': {
        0: [],
        18: [('turn', 'Spine2', 'U', 8), ('turn', 'Neck', 'U', 22), ('turn', 'Head', 'U', 28)],
        38: [('turn', 'Spine2', 'U', 8), ('turn', 'Neck', 'U', 24), ('turn', 'Head', 'U', 30), ('turn', 'Head', 'R', -6)],
        56: [('turn', 'Spine2', 'U', -8), ('turn', 'Neck', 'U', -22), ('turn', 'Head', 'U', -32)],
        76: [('turn', 'Spine2', 'U', -8), ('turn', 'Neck', 'U', -24), ('turn', 'Head', 'U', -30)],
        94: [],
    },
    # Idle fidget: arms-up stretch with a twist.
    'stretch': {
        0: [],
        14: [('swing', 'Spine2', '-F', 10), ('swing', 'Head', '-F', 10),
             ('swing', 'RightArm', 'U+R*0.35', 145), ('swing', 'RightForeArm', 'U', 8),
             ('swing', 'LeftArm', 'U-R*0.35', 145), ('swing', 'LeftForeArm', 'U', 8)],
        26: [('swing', 'Spine2', '-F', 10), ('turn', 'Spine1', 'U', 12),
             ('swing', 'RightArm', 'U+R*0.3', 150), ('swing', 'RightForeArm', 'U', 10),
             ('swing', 'LeftArm', 'U-R*0.3', 150), ('swing', 'LeftForeArm', 'U', 10)],
        38: [('swing', 'Spine2', '-F', 10), ('turn', 'Spine1', 'U', -12),
             ('swing', 'RightArm', 'U+R*0.3', 150), ('swing', 'RightForeArm', 'U', 10),
             ('swing', 'LeftArm', 'U-R*0.3', 150), ('swing', 'LeftForeArm', 'U', 10)],
        54: [],
    },
}

# name: clip it reflects left ↔ right
MIRROR = {'slashL': 'slash', 'punchL': 'punch', 'punch2': 'punch'}


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
sc = bpy.context.scene
sc.render.fps = FPS
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
ad = arm.animation_data
P = arm.pose.bones
bones = list(P)
HIPS = P['mixamorig:Hips']
for a in list(bpy.data.actions):  # some exports carry Blender's '.001' suffix on every clip
    if a.name.endswith('.001') and not bpy.data.actions.get(a.name[:-4]):
        a.name = a.name[:-4]
for a in list(bpy.data.actions):  # the source has its own 'jump' / 'fall'; free the names
    if a.name not in KEEP:
        a.name = 'src_' + a.name


def use(action):
    ad.action = action
    if action and action.slots:
        ad.action_slot = action.slots[0]


def grab():
    return [(pb.location.copy(), pb.rotation_quaternion.copy()) for pb in bones]


def put(pose):
    for pb, (loc, rot) in zip(bones, pose):
        pb.location, pb.rotation_quaternion = loc, rot
    bpy.context.view_layer.update()


def write(name, poses_at):
    """poses_at: [(frame, pose)] → a new action with every bone keyed on those frames."""
    new = bpy.data.actions.new(name)
    new.use_fake_user = True
    use(new)
    for f, pose in poses_at:
        put(pose)
        for pb in bones:
            if pb == HIPS:
                pb.keyframe_insert('location', frame=f, group=pb.name)
            pb.rotation_quaternion = pb.rotation_quaternion  # keep as is
            pb.keyframe_insert('rotation_quaternion', frame=f, group=pb.name)
    return new


use(bpy.data.actions['idle'])
sc.frame_set(0)
STANCE_HEAD = HIPS.head.copy()
UP0 = (arm.matrix_world.inverted().to_3x3() @ Vector((0, 0, 1))).normalized()  # true vertical in armature space


def resample(action, frames, center):
    """Pose at each (fractional) frame; with center, the hips' average horizontal offset from
    idle's stance is taken out so the body stays over the character's real position."""
    use(action)
    poses, heads = [], []
    for f in frames:
        sc.frame_set(int(f), subframe=f - int(f))
        heads.append(HIPS.head.copy())
        poses.append(grab())
    if not center:
        return poses
    d = sum(heads, Vector((0, 0, 0))) / len(heads) - STANCE_HEAD
    d -= UP0 * d.dot(UP0)
    if d.length < 0.005:
        return poses
    out = []
    for pose in poses:
        put(pose)
        M = HIPS.matrix.copy()
        M.translation -= d
        HIPS.matrix = M
        bpy.context.view_layer.update()
        out.append(grab())
    print(f'  centered {action.name}: hips slid {d.length:.3f} back over the feet')
    return out


# ---- run's hips sit ~0.6 body heights ahead of the feet (≈0.9 m in game): the body runs ahead
# of the character's real position and lurches on every jump / landing. Keep the vertical bob.
for name in ['run', 'walk']:
    action = bpy.data.actions[name]
    f0, f1 = (int(x) for x in action.frame_range)
    poses = resample(action, range(f0, f1 + 1), True)
    action.name = 'src_' + name
    write(name, list(enumerate(poses)))
    print(f'RECENTERED {name}')

# ---- trims from the mocap
for name, (src, segs, center) in TRIM.items():
    action = bpy.data.actions['src_' + src]
    frames = []
    for seg in segs:
        if seg[0] == 'hold':
            frames += [frames[-1]] * int(round(seg[1] * FPS))
        else:
            t0, t1 = seg
            frames += [t0 * FPS + i for i in range(int(round((t1 - t0) * FPS)) + 1)]
    write(name, list(enumerate(resample(action, frames, center))))
    print(f'TRIMMED {name}: {src} {segs}')

# ---- hand-keyed: base = idle's first frame, with the character's own axes measured off it
use(bpy.data.actions['idle'])
sc.frame_set(0)
BASE = grab()
use(None)
put(BASE)


def head(n):
    return P['mixamorig:' + n].head.copy()


U = (head('Head') - head('Hips')).normalized()
R = head('RightArm') - head('LeftArm')
R = (R - U * R.dot(U)).normalized()
F = U.cross(R).normalized()  # right-handed: up × right = forward
toe = head('LeftToeBase') - head('LeftFoot')
if toe.dot(F) < 0:  # trust the feet over the handedness guess
    F = -F
AX = {'F': F, 'R': R, 'U': U}
print('AXES F', tuple(round(x, 2) for x in F), 'R', tuple(round(x, 2) for x in R), 'U', tuple(round(x, 2) for x in U))


def vec(expr):
    """'F+U*0.5-R' → vector in armature space."""
    v = Vector((0, 0, 0))
    for term in expr.replace('-', '+-').split('+'):
        if not term:
            continue
        sign = -1 if term.startswith('-') else 1
        term = term.lstrip('-')
        k, _, w = term.partition('*')
        v += AX[k] * sign * (float(w) if w else 1.0)
    return v


def rotate(pb, axis, deg):
    h = pb.head.copy()
    pb.matrix = Matrix.Translation(h) @ Matrix.Rotation(math.radians(deg), 4, axis.normalized()) @ Matrix.Translation(-h) @ pb.matrix
    bpy.context.view_layer.update()


BODY_H = (head('Head') - (head('LeftFoot') + head('RightFoot')) / 2).length * 1.1


def clamp01(x):
    return min(1.0, max(0.0, x))


def reflect(v):
    return v - R * (2 * v.dot(R))


def apply(ops, mirror=False):
    for kind, bone, d, deg in ops:
        if mirror:
            bone = bone.replace('Left', '#').replace('Right', 'Left').replace('#', 'Right')
        pb = P['mixamorig:' + bone]
        if kind == 'drop':
            M = pb.matrix.copy()
            M.translation -= UP0 * (deg * BODY_H)
            pb.matrix = M
            bpy.context.view_layer.update()
        elif kind == 'turn':
            axis = vec(d)
            rotate(pb, -reflect(axis) if mirror else axis, deg)  # a reflected rotation's axis flips
        else:
            along = (pb.tail - pb.head).normalized()
            to = vec(d)
            to = (reflect(to) if mirror else to).normalized()
            axis = along.cross(to)
            if axis.length > 1e-4:
                rotate(pb, axis, deg)


for name, keys in list(KEYED.items()) + [(m, KEYED[src]) for m, src in MIRROR.items()]:
    poses = []
    for f, ops in sorted(keys.items()):
        put(BASE)
        apply(ops, mirror=name in MIRROR)
        poses.append((f, grab()))
    write(name, poses)
    print(f'KEYED {name}{" (mirrored)" if name in MIRROR else ""}: frames {sorted(keys)}')


def rogue_outfit():
    global CAPE_PARTS
    # ---- cape rig. Tripo skinned the one-shoulder cape to whatever it was near: arms and thighs. So
    # it tents out on every arm swing and drags between the legs on every stride. Give it its own
    # bones instead: CAPE_COLS strands hanging from Spine2 down the cloth's centre lines, CAPE_SEGS
    # bones each plus an end bone (so the last segment has a tail in glTF), and re-skin the cape
    # parts to them alone. glbhero.js runs the strands as springs.
    CAPE_PARTS = ['tripo_part_0', 'tripo_part_2', 'tripo_part_5', 'tripo_part_59', 'tripo_part_67']
    CAPE_COLS, CAPE_SEGS, CAPE_TOP = 3, 4, 0.4  # top of each strand fades from pinned to free over 40% of its length, so the cape keeps covering the tunic's torn back edge
    cape_objs = [bpy.data.objects[n] for n in CAPE_PARTS if n in bpy.data.objects]
    inv = arm.matrix_world.inverted()
    verts = []  # (object, index, armature-space rest position)
    for o in cape_objs:
        for v in o.data.vertices:
            verts.append((o, v.index, inv @ (o.matrix_world @ v.co)))
    use(None)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    sp = eb['mixamorig:Spine2']
    centre = sp.head.copy()
    upv = UP0


    def around(p):  # angle round the spine, and height
        d = p - centre
        d -= upv * d.dot(upv)
        return math.atan2(d.dot(AX['R']), d.dot(-AX['F'])), p.dot(upv)


    info = [(o, i, p) + around(p) for o, i, p in verts]
    angs = sorted(a for *_, a, _h in info)
    cols = [angs[int(len(angs) * q)] for q in [(c + 0.5) / CAPE_COLS for c in range(CAPE_COLS)]]
    half = (angs[-1] - angs[0]) / CAPE_COLS
    chains = []
    for c, ca in enumerate(cols):
        pts = [x for x in info if abs(x[3] - ca) < half]
        hs = sorted(x[4] for x in pts)
        top, bot = hs[int(len(hs) * 0.98)], hs[int(len(hs) * 0.02)]
        knots = []
        for k in range(CAPE_SEGS + 1):
            lvl = top + (bot - top) * k / CAPE_SEGS
            band = [x[2] for x in pts if abs(x[4] - lvl) < (top - bot) / CAPE_SEGS * 0.6] or [x[2] for x in pts]
            knots.append(sum(band, Vector((0, 0, 0))) / len(band))
        parent, names = sp, []
        for k in range(CAPE_SEGS + 1):
            b = eb.new(f'cape_{c}_{k}' if k < CAPE_SEGS else f'cape_{c}_end')
            b.head = knots[k]
            b.tail = knots[k + 1] if k < CAPE_SEGS else knots[k] + (knots[k] - knots[k - 1]) * 0.3
            b.parent = parent
            b.use_connect = False
            b.use_deform = k < CAPE_SEGS
            parent = b
            names.append(b.name)
        chains.append({'ang': ca, 'top': top, 'bot': bot, 'names': names[:-1]})
    bpy.ops.object.mode_set(mode='OBJECT')

    for o in cape_objs:
        for g in list(o.vertex_groups):
            o.vertex_groups.remove(g)
        o.vertex_groups.new(name='mixamorig:Spine2')
        o.vertex_groups.new(name='mixamorig:Spine1')
        for ch in chains:
            for n in ch['names']:
                o.vertex_groups.new(name=n)
    for o, i, p, a, hgt in info:
        # across: blend between the two nearest strands
        cw = [max(0.0, 1 - abs(a - ch['ang']) / (cols[1] - cols[0] if CAPE_COLS > 1 else 1)) for ch in chains]
        if sum(cw) < 1e-6:
            cw[min(range(CAPE_COLS), key=lambda c: abs(a - chains[c]['ang']))] = 1
        tot = sum(cw)
        for ch, w0 in zip(chains, cw):
            if w0 <= 0:
                continue
            s = clamp01((ch['top'] - hgt) / max(1e-6, ch['top'] - ch['bot']))
            u = s * CAPE_SEGS
            ws = [max(0.0, 1 - abs(u - (k + 0.5))) for k in range(CAPE_SEGS)]
            if u < 0.5:
                ws[0] = 1.0
            if u > CAPE_SEGS - 0.5:
                ws[-1] = 1.0
            pin = (lambda x: x * x * (3 - 2 * x))(clamp01(1 - s / CAPE_TOP))  # smooth, so the cloth can't crease at the edge
            wsum = sum(ws)
            for k, wk in enumerate(ws):
                if wk > 0:
                    o.vertex_groups[ch['names'][k]].add([i], w0 / tot * wk / wsum * (1 - pin), 'ADD')
            if pin > 0:  # pinned band: upper back on Spine2, lower down on Spine1 like the tunic beneath
                lo = clamp01(s / CAPE_TOP)
                o.vertex_groups['mixamorig:Spine2'].add([i], w0 / tot * pin * (1 - lo), 'ADD')
                o.vertex_groups['mixamorig:Spine1'].add([i], w0 / tot * pin * lo, 'ADD')
    print('CAPE', len(verts), 'verts on', len(chains), 'strands:', [round(math.degrees(c['ang'])) for c in chains])

    # ---- back pieces. The same auto-rig habit: back panels and a strap sliver (parts 44, 32, 17 …)
    # carry arm weights, so every arm swing tears shards out of her back. Any non-cape vertex behind
    # the spine and above the hips loses its arm / forearm / hand weights and follows the torso.
    ARM_RE = ('Arm', 'ForeArm', 'Hand')
    back_axis = -AX['F']
    spine_c = head('Spine1')
    hip_h = head('Hips').dot(UP0)
    TORSO_HALF = abs((head('RightShoulder') - head('LeftShoulder')).dot(AX['R'])) * 0.5 + 0.02  # back's half-width
    fixed = 0
    for o in bpy.data.objects:
        if o.type != 'MESH' or o.name in CAPE_PARTS or not o.vertex_groups:
            continue
        gname = {g.index: g.name for g in o.vertex_groups}
        for v in o.data.vertices:
            p = inv @ (o.matrix_world @ v.co)
            off = p - spine_c
            if off.dot(back_axis) < 0.012 or p.dot(UP0) < hip_h or abs(off.dot(AX['R'])) > TORSO_HALF:
                continue  # not on the back: in front, below the hips, or out on the arms
            # the middle of the back follows the spine alone; nearer the shoulder joints, the shoulders too
            parts = ARM_RE + ('Shoulder',)  # across the whole back: shoulder shrugs tore the tunic's edge out
            arm_gs = [g for g in v.groups if any(gname[g.group].replace('mixamorig:', '').startswith(side + part)
                      for side in ('Left', 'Right') for part in parts)]
            if not arm_gs:
                continue
            keep = sum(g.weight for g in v.groups if g not in arm_gs)
            idx = [g.group for g in arm_gs]
            for gi in idx:
                o.vertex_groups[gi].remove([v.index])
            if keep < 0.2:  # nothing torso-ish left: follow the spine at this height
                tgt = 'mixamorig:Spine2' if p.dot(UP0) > head('Spine2').dot(UP0) else 'mixamorig:Spine1'
                vg = o.vertex_groups.get(tgt) or o.vertex_groups.new(name=tgt)
                vg.add([v.index], 1.0, 'ADD')
            fixed += 1
    print('BACK FIX', fixed, 'vertices freed from the arms')
    # the tunic's torn back flaps (parts 12, 17, 56) stand off the back further than the cape's
    # inside, so they poke through it once the cape moves. They're always under the cape: press
    # them flat against the back.
    TUNIC = ['tripo_part_12', 'tripo_part_17', 'tripo_part_56']
    FLAT = 0.012  # how far behind the spine line they may sit
    flat = 0
    for n in TUNIC:
        o = bpy.data.objects.get(n)
        if not o:
            continue
        mw, mwi = o.matrix_world, o.matrix_world.inverted()
        for v in o.data.vertices:
            p = inv @ (mw @ v.co)
            off = p - spine_c
            d = off.dot(back_axis)
            if d > FLAT and abs(off.dot(AX['R'])) < TORSO_HALF:
                p2 = p - back_axis * (d - FLAT)
                v.co = mwi @ (arm.matrix_world @ p2)
                flat += 1
    print('TUNIC flattened', flat, 'vertices')
    # a stray strap sliver standing off the middle of the back: hidden under the cape when upright,
    # it pokes out once she leans into a run. Nothing else hangs on it, so drop it.
    for n in ['tripo_part_44']:
        if n in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
            print('REMOVED', n)


if PROFILE == 'rogue':
    rogue_outfit()

for a in list(bpy.data.actions):
    if a.name not in KEEP + list(TRIM) + list(KEYED) + list(MIRROR):
        bpy.data.actions.remove(a)
for a in bpy.data.actions:
    a.use_fake_user = True

use(bpy.data.actions['idle'])
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', export_animation_mode='ACTIONS',
    export_force_sampling=True, export_optimize_animation_size=True,
    export_anim_slide_to_zero=True, export_bake_animation=False,
)
print('WROTE', OUT, sorted(a.name for a in bpy.data.actions))
