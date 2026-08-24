/* exercises.js — LockIN exercise library and equipment taxonomy.
 *
 * Pure data plus pure filtering helpers. No DOM, no network, no Firebase, so
 * selftest.js can import this directly.
 *
 * Every exercise declares the equipment it REQUIRES. An exercise is available
 * to a user when their gym profile contains all of its requirements. An empty
 * `equipment` array means bodyweight-only, always available.
 */

/* ============================== taxonomy ============================== */

/* Muscles are deliberately coarse. Finer splits (long vs short head) do not
   change programming decisions at this level and only make volume charts noisy. */
export const MUSCLES = [
  'chest', 'lats', 'upper_back', 'traps', 'front_delts', 'side_delts',
  'rear_delts', 'biceps', 'triceps', 'forearms', 'quads', 'hamstrings',
  'glutes', 'calves', 'abs', 'obliques', 'lower_back', 'adductors', 'abductors',
];

export const MUSCLE_LABELS = {
  chest: 'Chest', lats: 'Lats', upper_back: 'Upper back', traps: 'Traps',
  front_delts: 'Front delts', side_delts: 'Side delts', rear_delts: 'Rear delts',
  biceps: 'Biceps', triceps: 'Triceps', forearms: 'Forearms', quads: 'Quads',
  hamstrings: 'Hamstrings', glutes: 'Glutes', calves: 'Calves', abs: 'Abs',
  obliques: 'Obliques', lower_back: 'Lower back', adductors: 'Adductors',
  abductors: 'Abductors',
};

/* Muscles roll up into groups for soreness check-ins and volume charts —
   nobody wants to rate nineteen sliders every morning. */
export const MUSCLE_GROUPS = {
  chest: ['chest'],
  back: ['lats', 'upper_back', 'traps'],
  shoulders: ['front_delts', 'side_delts', 'rear_delts'],
  arms: ['biceps', 'triceps', 'forearms'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors'],
  core: ['abs', 'obliques', 'lower_back'],
};

export const GROUP_LABELS = {
  chest: 'Chest', back: 'Back', shoulders: 'Shoulders',
  arms: 'Arms', legs: 'Legs', core: 'Core',
};

/** Which group a muscle belongs to. */
export function groupOf(muscle) {
  for (const [group, members] of Object.entries(MUSCLE_GROUPS)) {
    if (members.includes(muscle)) return group;
  }
  return null;
}

/** Every muscle in the named groups, flattened and deduped. */
export function musclesInGroups(groups) {
  const out = new Set();
  for (const g of groups || []) for (const m of MUSCLE_GROUPS[g] || []) out.add(m);
  return [...out];
}

/* Equipment is grouped only for rendering the setup checklist; the ids are a
   flat namespace everywhere else. */
export const EQUIPMENT_CATEGORIES = [
  { id: 'free_weights', label: 'Free weights', items: [
    ['barbell', 'Barbell'], ['dumbbell', 'Dumbbells'], ['kettlebell', 'Kettlebells'],
    ['ez_bar', 'EZ curl bar'], ['trap_bar', 'Trap / hex bar'], ['plate', 'Weight plates'],
  ] },
  { id: 'benches', label: 'Benches and racks', items: [
    ['flat_bench', 'Flat bench'], ['adjustable_bench', 'Adjustable / incline bench'],
    ['squat_rack', 'Squat rack or power cage'], ['smith', 'Smith machine'],
    ['preacher_bench', 'Preacher bench'], ['glute_ham', 'Glute-ham / back extension'],
  ] },
  { id: 'bodyweight', label: 'Bodyweight and portable', items: [
    ['pullup_bar', 'Pull-up bar'], ['dip_bars', 'Dip bars'], ['band', 'Resistance bands'],
    ['ab_wheel', 'Ab wheel'], ['trx', 'Suspension trainer'], ['box', 'Plyo box or step'],
    ['jump_rope', 'Jump rope'], ['medicine_ball', 'Medicine ball'],
  ] },
  { id: 'cables', label: 'Cables', items: [
    ['cable', 'Cable stack'], ['lat_pulldown', 'Lat pulldown'], ['seated_row', 'Seated row'],
  ] },
  { id: 'machines', label: 'Machines', items: [
    ['leg_press', 'Leg press'], ['hack_squat', 'Hack squat'],
    ['leg_curl', 'Leg curl'], ['leg_extension', 'Leg extension'],
    ['chest_press_machine', 'Chest press machine'], ['pec_deck', 'Pec deck / fly machine'],
    ['shoulder_press_machine', 'Shoulder press machine'], ['row_machine', 'Row machine'],
    ['calf_machine', 'Calf raise machine'], ['assisted_pullup', 'Assisted pull-up machine'],
    ['hip_thrust_machine', 'Hip thrust machine'], ['abductor_machine', 'Ab/adductor machine'],
    ['landmine', 'Landmine'],
  ] },
  { id: 'cardio', label: 'Cardio', items: [
    ['treadmill', 'Treadmill'], ['bike', 'Stationary bike'], ['rower', 'Rowing machine'],
    ['elliptical', 'Elliptical'], ['stairmaster', 'Stair climber'],
  ] },
];

export const EQUIPMENT_LABELS = Object.fromEntries(
  EQUIPMENT_CATEGORIES.flatMap((c) => c.items)
);

export const ALL_EQUIPMENT = Object.keys(EQUIPMENT_LABELS);

/* One-tap presets for onboarding. Commercial gyms have essentially everything;
   the home preset is the common "dumbbells, a bench and a bar in the garage". */
export const PRESET_COMMERCIAL_GYM = ALL_EQUIPMENT.slice();

export const PRESET_HOME_GYM = [
  'dumbbell', 'adjustable_bench', 'band', 'pullup_bar', 'box', 'jump_rope', 'kettlebell',
];

export const PATTERNS = [
  'squat', 'hinge', 'lunge', 'horizontal_push', 'vertical_push',
  'horizontal_pull', 'vertical_pull', 'carry', 'isolation', 'core', 'cardio',
];

export const PATTERN_LABELS = {
  squat: 'Squat', hinge: 'Hinge', lunge: 'Lunge',
  horizontal_push: 'Horizontal push', vertical_push: 'Vertical push',
  horizontal_pull: 'Horizontal pull', vertical_pull: 'Vertical pull',
  carry: 'Carry', isolation: 'Isolation', core: 'Core', cardio: 'Cardio',
};

/* ============================== library ============================== */

/* type: 'compound' | 'isolation' | 'cardio'
 * unilateral: trains one side at a time, so a logged "set" is one side.
 * bw: load comes from bodyweight, so logged weight is ADDED weight and 0 is valid.
 */
const E = (id, name, pattern, type, primary, secondary, equipment, opts = {}) =>
  ({ id, name, pattern, type, primary, secondary, equipment,
    unilateral: !!opts.unilateral, bw: !!opts.bw });

export const EXERCISES = [
  /* ---------- squat ---------- */
  E('back_squat', 'Back Squat', 'squat', 'compound', ['quads'], ['glutes', 'lower_back', 'adductors'], ['barbell', 'squat_rack']),
  E('front_squat', 'Front Squat', 'squat', 'compound', ['quads'], ['glutes', 'abs', 'upper_back'], ['barbell', 'squat_rack']),
  E('goblet_squat', 'Goblet Squat', 'squat', 'compound', ['quads'], ['glutes', 'abs'], ['dumbbell']),
  E('kb_goblet_squat', 'Kettlebell Goblet Squat', 'squat', 'compound', ['quads'], ['glutes', 'abs'], ['kettlebell']),
  E('smith_squat', 'Smith Machine Squat', 'squat', 'compound', ['quads'], ['glutes'], ['smith']),
  E('hack_squat_m', 'Hack Squat', 'squat', 'compound', ['quads'], ['glutes'], ['hack_squat']),
  E('leg_press_m', 'Leg Press', 'squat', 'compound', ['quads'], ['glutes', 'adductors'], ['leg_press']),
  E('bodyweight_squat', 'Bodyweight Squat', 'squat', 'compound', ['quads'], ['glutes'], [], { bw: true }),
  E('box_squat', 'Box Squat', 'squat', 'compound', ['quads'], ['glutes', 'hamstrings'], ['barbell', 'squat_rack', 'box']),
  E('zercher_squat', 'Zercher Squat', 'squat', 'compound', ['quads'], ['glutes', 'abs', 'upper_back'], ['barbell', 'squat_rack']),
  E('landmine_squat', 'Landmine Squat', 'squat', 'compound', ['quads'], ['glutes', 'abs'], ['landmine', 'barbell']),

  /* ---------- hinge ---------- */
  E('deadlift', 'Conventional Deadlift', 'hinge', 'compound', ['hamstrings', 'glutes'], ['lower_back', 'lats', 'traps', 'forearms'], ['barbell']),
  E('sumo_deadlift', 'Sumo Deadlift', 'hinge', 'compound', ['glutes', 'quads'], ['hamstrings', 'lower_back', 'adductors'], ['barbell']),
  E('trap_bar_deadlift', 'Trap Bar Deadlift', 'hinge', 'compound', ['quads', 'glutes'], ['hamstrings', 'lower_back', 'traps'], ['trap_bar']),
  E('rdl', 'Romanian Deadlift', 'hinge', 'compound', ['hamstrings'], ['glutes', 'lower_back'], ['barbell']),
  E('db_rdl', 'Dumbbell Romanian Deadlift', 'hinge', 'compound', ['hamstrings'], ['glutes', 'lower_back'], ['dumbbell']),
  E('single_leg_rdl', 'Single-Leg RDL', 'hinge', 'compound', ['hamstrings'], ['glutes', 'lower_back'], ['dumbbell'], { unilateral: true }),
  E('good_morning', 'Good Morning', 'hinge', 'compound', ['hamstrings'], ['lower_back', 'glutes'], ['barbell', 'squat_rack']),
  E('hip_thrust', 'Barbell Hip Thrust', 'hinge', 'compound', ['glutes'], ['hamstrings'], ['barbell', 'flat_bench']),
  E('hip_thrust_m', 'Machine Hip Thrust', 'hinge', 'compound', ['glutes'], ['hamstrings'], ['hip_thrust_machine']),
  E('glute_bridge', 'Glute Bridge', 'hinge', 'compound', ['glutes'], ['hamstrings'], [], { bw: true }),
  E('kb_swing', 'Kettlebell Swing', 'hinge', 'compound', ['glutes', 'hamstrings'], ['lower_back', 'abs'], ['kettlebell']),
  E('back_extension', 'Back Extension', 'hinge', 'isolation', ['lower_back'], ['glutes', 'hamstrings'], ['glute_ham'], { bw: true }),
  E('cable_pull_through', 'Cable Pull-Through', 'hinge', 'compound', ['glutes'], ['hamstrings'], ['cable']),
  E('rack_pull', 'Rack Pull', 'hinge', 'compound', ['lower_back', 'traps'], ['hamstrings', 'glutes', 'forearms'], ['barbell', 'squat_rack']),

  /* ---------- lunge ---------- */
  E('walking_lunge', 'Walking Lunge', 'lunge', 'compound', ['quads'], ['glutes', 'hamstrings'], ['dumbbell'], { unilateral: true }),
  E('reverse_lunge', 'Reverse Lunge', 'lunge', 'compound', ['quads'], ['glutes'], ['dumbbell'], { unilateral: true }),
  E('bulgarian_split_squat', 'Bulgarian Split Squat', 'lunge', 'compound', ['quads'], ['glutes', 'adductors'], ['dumbbell', 'flat_bench'], { unilateral: true }),
  E('split_squat', 'Split Squat', 'lunge', 'compound', ['quads'], ['glutes'], ['dumbbell'], { unilateral: true }),
  E('step_up', 'Step-Up', 'lunge', 'compound', ['quads'], ['glutes'], ['dumbbell', 'box'], { unilateral: true }),
  E('bw_lunge', 'Bodyweight Lunge', 'lunge', 'compound', ['quads'], ['glutes'], [], { bw: true, unilateral: true }),
  E('curtsy_lunge', 'Curtsy Lunge', 'lunge', 'compound', ['glutes'], ['quads', 'abductors'], ['dumbbell'], { unilateral: true }),
  E('sissy_squat', 'Sissy Squat', 'lunge', 'isolation', ['quads'], [], [], { bw: true }),

  /* ---------- horizontal push ---------- */
  E('bench_press', 'Barbell Bench Press', 'horizontal_push', 'compound', ['chest'], ['triceps', 'front_delts'], ['barbell', 'flat_bench']),
  E('incline_bench', 'Incline Barbell Press', 'horizontal_push', 'compound', ['chest'], ['front_delts', 'triceps'], ['barbell', 'adjustable_bench']),
  E('decline_bench', 'Decline Barbell Press', 'horizontal_push', 'compound', ['chest'], ['triceps'], ['barbell', 'adjustable_bench']),
  E('db_bench', 'Dumbbell Bench Press', 'horizontal_push', 'compound', ['chest'], ['triceps', 'front_delts'], ['dumbbell', 'flat_bench']),
  E('db_incline', 'Incline Dumbbell Press', 'horizontal_push', 'compound', ['chest'], ['front_delts', 'triceps'], ['dumbbell', 'adjustable_bench']),
  E('smith_bench', 'Smith Machine Bench Press', 'horizontal_push', 'compound', ['chest'], ['triceps'], ['smith', 'flat_bench']),
  E('chest_press_m', 'Machine Chest Press', 'horizontal_push', 'compound', ['chest'], ['triceps', 'front_delts'], ['chest_press_machine']),
  E('pushup', 'Push-Up', 'horizontal_push', 'compound', ['chest'], ['triceps', 'front_delts', 'abs'], [], { bw: true }),
  E('incline_pushup', 'Incline Push-Up', 'horizontal_push', 'compound', ['chest'], ['triceps'], ['box'], { bw: true }),
  E('deficit_pushup', 'Deficit Push-Up', 'horizontal_push', 'compound', ['chest'], ['triceps', 'front_delts'], ['dumbbell'], { bw: true }),
  E('dip', 'Chest Dip', 'horizontal_push', 'compound', ['chest'], ['triceps', 'front_delts'], ['dip_bars'], { bw: true }),
  E('floor_press', 'Floor Press', 'horizontal_push', 'compound', ['chest'], ['triceps'], ['dumbbell']),
  E('landmine_press', 'Landmine Press', 'horizontal_push', 'compound', ['front_delts'], ['chest', 'triceps'], ['landmine', 'barbell'], { unilateral: true }),
  E('close_grip_bench', 'Close-Grip Bench Press', 'horizontal_push', 'compound', ['triceps'], ['chest', 'front_delts'], ['barbell', 'flat_bench']),

  /* ---------- vertical push ---------- */
  E('ohp', 'Overhead Press', 'vertical_push', 'compound', ['front_delts'], ['triceps', 'abs', 'side_delts'], ['barbell']),
  E('db_shoulder_press', 'Dumbbell Shoulder Press', 'vertical_push', 'compound', ['front_delts'], ['triceps', 'side_delts'], ['dumbbell']),
  E('seated_db_press', 'Seated Dumbbell Press', 'vertical_push', 'compound', ['front_delts'], ['triceps', 'side_delts'], ['dumbbell', 'adjustable_bench']),
  E('arnold_press', 'Arnold Press', 'vertical_push', 'compound', ['front_delts'], ['side_delts', 'triceps'], ['dumbbell']),
  E('push_press', 'Push Press', 'vertical_push', 'compound', ['front_delts'], ['triceps', 'quads', 'abs'], ['barbell']),
  E('shoulder_press_m', 'Machine Shoulder Press', 'vertical_push', 'compound', ['front_delts'], ['triceps'], ['shoulder_press_machine']),
  E('smith_ohp', 'Smith Machine Overhead Press', 'vertical_push', 'compound', ['front_delts'], ['triceps'], ['smith']),
  E('pike_pushup', 'Pike Push-Up', 'vertical_push', 'compound', ['front_delts'], ['triceps'], [], { bw: true }),
  E('kb_press', 'Kettlebell Overhead Press', 'vertical_push', 'compound', ['front_delts'], ['triceps', 'abs'], ['kettlebell'], { unilateral: true }),

  /* ---------- vertical pull ---------- */
  E('pullup', 'Pull-Up', 'vertical_pull', 'compound', ['lats'], ['biceps', 'upper_back', 'forearms'], ['pullup_bar'], { bw: true }),
  E('chinup', 'Chin-Up', 'vertical_pull', 'compound', ['lats'], ['biceps', 'upper_back'], ['pullup_bar'], { bw: true }),
  E('neutral_pullup', 'Neutral-Grip Pull-Up', 'vertical_pull', 'compound', ['lats'], ['biceps', 'upper_back'], ['pullup_bar'], { bw: true }),
  E('assisted_pullup_m', 'Assisted Pull-Up', 'vertical_pull', 'compound', ['lats'], ['biceps'], ['assisted_pullup'], { bw: true }),
  E('lat_pulldown_m', 'Lat Pulldown', 'vertical_pull', 'compound', ['lats'], ['biceps', 'upper_back'], ['lat_pulldown']),
  E('close_grip_pulldown', 'Close-Grip Pulldown', 'vertical_pull', 'compound', ['lats'], ['biceps'], ['lat_pulldown']),
  E('straight_arm_pulldown', 'Straight-Arm Pulldown', 'vertical_pull', 'isolation', ['lats'], ['triceps'], ['cable']),
  E('band_pulldown', 'Band Lat Pulldown', 'vertical_pull', 'compound', ['lats'], ['biceps'], ['band']),

  /* ---------- horizontal pull ---------- */
  E('barbell_row', 'Barbell Row', 'horizontal_pull', 'compound', ['upper_back'], ['lats', 'biceps', 'lower_back'], ['barbell']),
  E('pendlay_row', 'Pendlay Row', 'horizontal_pull', 'compound', ['upper_back'], ['lats', 'biceps'], ['barbell']),
  E('db_row', 'Dumbbell Row', 'horizontal_pull', 'compound', ['lats'], ['upper_back', 'biceps'], ['dumbbell', 'flat_bench'], { unilateral: true }),
  E('chest_supported_row', 'Chest-Supported Row', 'horizontal_pull', 'compound', ['upper_back'], ['lats', 'biceps', 'rear_delts'], ['dumbbell', 'adjustable_bench']),
  E('seated_cable_row', 'Seated Cable Row', 'horizontal_pull', 'compound', ['upper_back'], ['lats', 'biceps'], ['seated_row']),
  E('row_machine_m', 'Machine Row', 'horizontal_pull', 'compound', ['upper_back'], ['lats', 'biceps'], ['row_machine']),
  E('t_bar_row', 'T-Bar Row', 'horizontal_pull', 'compound', ['upper_back'], ['lats', 'biceps'], ['landmine', 'barbell']),
  E('inverted_row', 'Inverted Row', 'horizontal_pull', 'compound', ['upper_back'], ['lats', 'biceps'], ['squat_rack', 'barbell'], { bw: true }),
  E('trx_row', 'Suspension Row', 'horizontal_pull', 'compound', ['upper_back'], ['lats', 'biceps'], ['trx'], { bw: true }),
  E('band_row', 'Band Row', 'horizontal_pull', 'compound', ['upper_back'], ['lats', 'biceps'], ['band']),
  E('face_pull', 'Face Pull', 'horizontal_pull', 'isolation', ['rear_delts'], ['upper_back', 'traps'], ['cable']),
  E('meadows_row', 'Meadows Row', 'horizontal_pull', 'compound', ['lats'], ['upper_back', 'biceps'], ['landmine', 'barbell'], { unilateral: true }),

  /* ---------- shoulders isolation ---------- */
  E('lateral_raise', 'Dumbbell Lateral Raise', 'isolation', 'isolation', ['side_delts'], [], ['dumbbell']),
  E('cable_lateral', 'Cable Lateral Raise', 'isolation', 'isolation', ['side_delts'], [], ['cable'], { unilateral: true }),
  E('band_lateral', 'Band Lateral Raise', 'isolation', 'isolation', ['side_delts'], [], ['band']),
  E('front_raise', 'Front Raise', 'isolation', 'isolation', ['front_delts'], [], ['dumbbell']),
  E('rear_delt_fly', 'Rear Delt Fly', 'isolation', 'isolation', ['rear_delts'], ['upper_back'], ['dumbbell']),
  E('reverse_pec_deck', 'Reverse Pec Deck', 'isolation', 'isolation', ['rear_delts'], ['upper_back'], ['pec_deck']),
  E('upright_row', 'Upright Row', 'isolation', 'compound', ['side_delts'], ['traps', 'biceps'], ['barbell']),
  E('shrug', 'Barbell Shrug', 'isolation', 'isolation', ['traps'], ['forearms'], ['barbell']),
  E('db_shrug', 'Dumbbell Shrug', 'isolation', 'isolation', ['traps'], ['forearms'], ['dumbbell']),

  /* ---------- chest isolation ---------- */
  E('cable_fly', 'Cable Fly', 'isolation', 'isolation', ['chest'], ['front_delts'], ['cable']),
  E('db_fly', 'Dumbbell Fly', 'isolation', 'isolation', ['chest'], ['front_delts'], ['dumbbell', 'flat_bench']),
  E('pec_deck_m', 'Pec Deck', 'isolation', 'isolation', ['chest'], [], ['pec_deck']),
  E('incline_cable_fly', 'Incline Cable Fly', 'isolation', 'isolation', ['chest'], ['front_delts'], ['cable', 'adjustable_bench']),
  E('pullover', 'Dumbbell Pullover', 'isolation', 'isolation', ['lats'], ['chest', 'triceps'], ['dumbbell', 'flat_bench']),

  /* ---------- biceps ---------- */
  E('barbell_curl', 'Barbell Curl', 'isolation', 'isolation', ['biceps'], ['forearms'], ['barbell']),
  E('ez_curl', 'EZ Bar Curl', 'isolation', 'isolation', ['biceps'], ['forearms'], ['ez_bar']),
  E('db_curl', 'Dumbbell Curl', 'isolation', 'isolation', ['biceps'], ['forearms'], ['dumbbell']),
  E('hammer_curl', 'Hammer Curl', 'isolation', 'isolation', ['biceps'], ['forearms'], ['dumbbell']),
  E('incline_curl', 'Incline Dumbbell Curl', 'isolation', 'isolation', ['biceps'], [], ['dumbbell', 'adjustable_bench']),
  E('preacher_curl', 'Preacher Curl', 'isolation', 'isolation', ['biceps'], [], ['preacher_bench', 'ez_bar']),
  E('cable_curl', 'Cable Curl', 'isolation', 'isolation', ['biceps'], ['forearms'], ['cable']),
  E('concentration_curl', 'Concentration Curl', 'isolation', 'isolation', ['biceps'], [], ['dumbbell'], { unilateral: true }),
  E('band_curl', 'Band Curl', 'isolation', 'isolation', ['biceps'], ['forearms'], ['band']),

  /* ---------- triceps ---------- */
  E('skullcrusher', 'Skullcrusher', 'isolation', 'isolation', ['triceps'], [], ['ez_bar', 'flat_bench']),
  E('tricep_pushdown', 'Tricep Pushdown', 'isolation', 'isolation', ['triceps'], [], ['cable']),
  E('rope_pushdown', 'Rope Pushdown', 'isolation', 'isolation', ['triceps'], [], ['cable']),
  E('overhead_extension', 'Overhead Tricep Extension', 'isolation', 'isolation', ['triceps'], [], ['dumbbell']),
  E('cable_overhead_ext', 'Cable Overhead Extension', 'isolation', 'isolation', ['triceps'], [], ['cable']),
  E('tricep_dip', 'Tricep Dip', 'isolation', 'compound', ['triceps'], ['chest', 'front_delts'], ['dip_bars'], { bw: true }),
  E('bench_dip', 'Bench Dip', 'isolation', 'compound', ['triceps'], ['front_delts'], ['flat_bench'], { bw: true }),
  E('kickback', 'Tricep Kickback', 'isolation', 'isolation', ['triceps'], [], ['dumbbell'], { unilateral: true }),
  E('diamond_pushup', 'Diamond Push-Up', 'isolation', 'compound', ['triceps'], ['chest'], [], { bw: true }),

  /* ---------- legs isolation ---------- */
  E('leg_extension_m', 'Leg Extension', 'isolation', 'isolation', ['quads'], [], ['leg_extension']),
  E('lying_leg_curl', 'Lying Leg Curl', 'isolation', 'isolation', ['hamstrings'], ['calves'], ['leg_curl']),
  E('seated_leg_curl', 'Seated Leg Curl', 'isolation', 'isolation', ['hamstrings'], [], ['leg_curl']),
  E('nordic_curl', 'Nordic Hamstring Curl', 'isolation', 'isolation', ['hamstrings'], [], [], { bw: true }),
  E('standing_calf_raise', 'Standing Calf Raise', 'isolation', 'isolation', ['calves'], [], ['calf_machine']),
  E('seated_calf_raise', 'Seated Calf Raise', 'isolation', 'isolation', ['calves'], [], ['calf_machine']),
  E('db_calf_raise', 'Dumbbell Calf Raise', 'isolation', 'isolation', ['calves'], [], ['dumbbell']),
  E('bw_calf_raise', 'Bodyweight Calf Raise', 'isolation', 'isolation', ['calves'], [], [], { bw: true }),
  E('hip_abduction', 'Hip Abduction', 'isolation', 'isolation', ['abductors'], ['glutes'], ['abductor_machine']),
  E('hip_adduction', 'Hip Adduction', 'isolation', 'isolation', ['adductors'], [], ['abductor_machine']),
  E('cable_kickback', 'Cable Glute Kickback', 'isolation', 'isolation', ['glutes'], ['hamstrings'], ['cable'], { unilateral: true }),
  E('band_clamshell', 'Band Clamshell', 'isolation', 'isolation', ['abductors'], ['glutes'], ['band'], { unilateral: true }),

  /* ---------- core ---------- */
  E('plank', 'Plank', 'core', 'isolation', ['abs'], ['obliques'], [], { bw: true }),
  E('side_plank', 'Side Plank', 'core', 'isolation', ['obliques'], ['abs'], [], { bw: true, unilateral: true }),
  E('hanging_leg_raise', 'Hanging Leg Raise', 'core', 'isolation', ['abs'], ['obliques'], ['pullup_bar'], { bw: true }),
  E('cable_crunch', 'Cable Crunch', 'core', 'isolation', ['abs'], [], ['cable']),
  E('ab_wheel_rollout', 'Ab Wheel Rollout', 'core', 'isolation', ['abs'], ['lats', 'lower_back'], ['ab_wheel'], { bw: true }),
  E('crunch', 'Crunch', 'core', 'isolation', ['abs'], [], [], { bw: true }),
  E('bicycle_crunch', 'Bicycle Crunch', 'core', 'isolation', ['obliques'], ['abs'], [], { bw: true }),
  E('russian_twist', 'Russian Twist', 'core', 'isolation', ['obliques'], ['abs'], ['medicine_ball'], { bw: true }),
  E('dead_bug', 'Dead Bug', 'core', 'isolation', ['abs'], [], [], { bw: true }),
  E('pallof_press', 'Pallof Press', 'core', 'isolation', ['obliques'], ['abs'], ['cable'], { unilateral: true }),
  E('mountain_climber', 'Mountain Climber', 'core', 'isolation', ['abs'], [], [], { bw: true }),
  E('hollow_hold', 'Hollow Body Hold', 'core', 'isolation', ['abs'], [], [], { bw: true }),

  /* ---------- carries and forearms ---------- */
  E('farmers_carry', 'Farmer’s Carry', 'carry', 'compound', ['forearms'], ['traps', 'abs', 'obliques'], ['dumbbell']),
  E('suitcase_carry', 'Suitcase Carry', 'carry', 'compound', ['obliques'], ['forearms', 'traps'], ['dumbbell'], { unilateral: true }),
  E('wrist_curl', 'Wrist Curl', 'isolation', 'isolation', ['forearms'], [], ['dumbbell']),
  E('reverse_curl', 'Reverse Curl', 'isolation', 'isolation', ['forearms'], ['biceps'], ['ez_bar']),
  E('dead_hang', 'Dead Hang', 'isolation', 'isolation', ['forearms'], ['lats'], ['pullup_bar'], { bw: true }),

  /* ---------- cardio ---------- */
  E('run_outdoor', 'Outdoor Run', 'cardio', 'cardio', [], ['quads', 'calves', 'hamstrings'], []),
  E('walk', 'Walk', 'cardio', 'cardio', [], ['calves'], []),
  E('treadmill_run', 'Treadmill Run', 'cardio', 'cardio', [], ['quads', 'calves'], ['treadmill']),
  E('incline_walk', 'Incline Treadmill Walk', 'cardio', 'cardio', [], ['glutes', 'calves'], ['treadmill']),
  E('cycling', 'Cycling', 'cardio', 'cardio', [], ['quads', 'glutes'], ['bike']),
  E('outdoor_bike', 'Outdoor Cycling', 'cardio', 'cardio', [], ['quads', 'glutes'], []),
  E('rowing', 'Rowing', 'cardio', 'cardio', [], ['upper_back', 'quads', 'lats'], ['rower']),
  E('elliptical_c', 'Elliptical', 'cardio', 'cardio', [], ['quads', 'glutes'], ['elliptical']),
  E('stairmaster_c', 'Stair Climber', 'cardio', 'cardio', [], ['glutes', 'quads', 'calves'], ['stairmaster']),
  E('jump_rope_c', 'Jump Rope', 'cardio', 'cardio', [], ['calves'], ['jump_rope']),
  E('swim', 'Swimming', 'cardio', 'cardio', [], ['lats', 'front_delts'], []),
  E('hike', 'Hike', 'cardio', 'cardio', [], ['quads', 'glutes', 'calves'], []),
];

/* Fast lookup — the UI resolves ids to exercises constantly. */
export const BY_ID = Object.fromEntries(EXERCISES.map((e) => [e.id, e]));

/** Resolve an exercise id. Returns undefined for unknown ids. */
export const exerciseById = (id) => BY_ID[id];

/* ============================== filtering ============================== */

/**
 * True when `equipment` (a user's gym profile) satisfies everything the
 * exercise requires. Bodyweight exercises require nothing and always pass.
 */
export function isAvailable(exercise, equipment) {
  const have = new Set(equipment || []);
  return exercise.equipment.every((req) => have.has(req));
}

/**
 * Every exercise a user can actually perform, optionally narrowed further.
 *
 * This is the gate that guarantees a generated program never prescribes a hack
 * squat to someone training in a spare bedroom. The model only ever sees the
 * output of this function, so it cannot invent equipment the user lacks.
 *
 * @param {string[]}  equipment      ids from the user's active gym profile
 * @param {object}   [opts]
 * @param {string}   [opts.pattern]  restrict to one movement pattern
 * @param {string}   [opts.type]     'compound' | 'isolation' | 'cardio'
 * @param {string}   [opts.muscle]   trains this muscle (primary or secondary)
 * @param {string}   [opts.group]    trains any muscle in this group
 * @param {string[]} [opts.exclude]  exercise ids to leave out
 */
export function availableExercises(equipment, opts = {}) {
  const excluded = new Set(opts.exclude || []);
  const groupMuscles = opts.group ? MUSCLE_GROUPS[opts.group] || [] : null;

  return EXERCISES.filter((e) => {
    if (excluded.has(e.id)) return false;
    if (!isAvailable(e, equipment)) return false;
    if (opts.pattern && e.pattern !== opts.pattern) return false;
    if (opts.type && e.type !== opts.type) return false;
    if (opts.muscle && !e.primary.includes(opts.muscle) && !e.secondary.includes(opts.muscle)) return false;
    if (groupMuscles && !groupMuscles.some((m) => e.primary.includes(m) || e.secondary.includes(m))) return false;
    return true;
  });
}

/**
 * Candidate replacements for an exercise, best match first.
 *
 * Used by the soreness swap in program.js and by the "swap this" button. Scores
 * shared primary muscles first, then pattern, then type, so a Barbell Row
 * prefers a Dumbbell Row over a Face Pull even though both train the back.
 *
 * @param {string[]} [opts.avoidMuscles] muscles the swap must not train directly
 */
export function findSwaps(exerciseId, equipment, opts = {}) {
  const original = BY_ID[exerciseId];
  if (!original) return [];

  const avoid = new Set(opts.avoidMuscles || []);
  const exclude = new Set([exerciseId, ...(opts.exclude || [])]);

  return availableExercises(equipment)
    .filter((e) => !exclude.has(e.id))
    /* A swap that hammers the muscle we are trying to spare is not a swap. */
    .filter((e) => !e.primary.some((m) => avoid.has(m)))
    .map((e) => {
      const sharedPrimary = e.primary.filter((m) => original.primary.includes(m)).length;
      const sharedSecondary = e.secondary.filter((m) => original.primary.includes(m)).length;
      const muscleScore = sharedPrimary * 10 + sharedSecondary * 3;

      /* Muscle overlap is the QUALIFIER; pattern and type only break ties among
         exercises that already train the right thing. Adding those bonuses to
         the qualifying score let a Bodyweight Squat rank as a swap for a
         Push-Up purely for both being compound — technically scored, obviously
         wrong in a gym. */
      if (muscleScore === 0) return { exercise: e, score: 0 };

      let score = muscleScore;
      if (e.pattern === original.pattern) score += 5;
      if (e.type === original.type) score += 2;
      return { exercise: e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.exercise);
}
