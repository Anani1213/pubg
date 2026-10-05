/**
 * js/player.js
 * ---------------------------------------------------------------------------
 * Modular third-person (PUBG-style) player controller for a Three.js mobile
 * WebGL game.
 *
 * The character mesh is a real, pre-rigged, skinned GLB model (the Mixamo
 * "Soldier" model shipped with three.js) loaded from a public CDN. No
 * procedural / primitive geometry is generated anywhere in this file.
 *
 * Required host-page import map (three r160+):
 *
 *   <script type="importmap">
 *   {
 *     "imports": {
 *       "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
 *       "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
 *     }
 *   }
 *   </script>
 *
 * Usage:
 *   import Player from './js/player.js';
 *
 *   const player = new Player();
 *   await player.init(scene);
 *   player.setCamera(camera);
 *
 *   // Inside your render loop:
 *   player.update(deltaTime, joystickVector, isRunning);
 *
 * `joystickVector` is any object with numeric `.x` (strafe) and `.y` (forward)
 * properties in the range [-1, 1]. When a camera is attached the input is
 * interpreted as camera-relative; otherwise it is treated as world-space.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

/**
 * Primary CDN URL for the pre-rigged animated Soldier GLB.
 * Served by jsDelivr (CORS enabled, pinned to three.js r160).
 */
const DEFAULT_MODEL_URL =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/Soldier.glb';

/**
 * Fallback URL (raw GitHub) in case the jsDelivr edge is unavailable.
 */
const DEFAULT_MODEL_FALLBACK_URL =
  'https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/models/gltf/Soldier.glb';

/** Reusable world up vector (avoids per-frame allocations). */
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/* -------------------------------------------------------------------------- */
/*                              Default settings                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG = Object.freeze({
  /* --- Model --- */
  modelUrl: DEFAULT_MODEL_URL,
  modelFallbackUrl: DEFAULT_MODEL_FALLBACK_URL,

  /**
   * The Mixamo Soldier model faces -Z by default. Rotating the inner model
   * by PI aligns its visual front with the parent group's +Z axis, which lets
   * us use the standard three.js forward convention (atan2(dir.x, dir.z)).
   * Change this if you swap in a model with a different bind orientation.
   */
  modelYawOffset: Math.PI,

  /* --- Movement --- */
  walkSpeed: 2.4,              // metres / second
  runSpeed: 6.8,               // metres / second
  acceleration: 18,            // exponential damping lambda while speeding up
  deceleration: 26,            // exponential damping lambda while slowing down
  rotationLambda: 12,          // yaw convergence speed (higher = snappier)
  inputDeadzone: 0.1,          // analog stick dead-zone (0..1)
  groundY: 0,                  // locked world Y for the feet
  maxDeltaTime: 0.1,           // clamp huge frame steps (tab switch, GC hitch)
  maxSpeedMultiplier: 1.05,    // hard cap = runSpeed * this

  /* --- Animation state machine --- */
  animationFadeDuration: 0.25, // cross-fade time between clips (seconds)
  idleSpeedThreshold: 0.2,     // below this speed -> Idle
  runSpeedThreshold: 3.5,      // above this speed (with isRunning) -> Run
  referenceWalkSpeed: 1.8,     // speed at which Walk clip plays at timeScale 1
  referenceRunSpeed: 5.0,      // speed at which Run clip plays at timeScale 1

  /* --- Animation clip resolution --- */
  clipAliases: {
    idle: ['idle', 'Idle', 'TPose', 'tpose'],
    walk: ['walk', 'Walk', 'walking', 'Walking'],
    run:  ['run', 'Run', 'running', 'Running'],
  },
  /**
   * Index fallbacks for the three.js Soldier.glb, whose animation array is
   * alphabetically ordered: [0] = idle, [1] = run, [2] = TPose, [3] = walk.
   */
  fallbackIndices: { idle: 0, run: 1, walk: 3 },

  /* --- Rendering --- */
  shadow: true,
});

/* -------------------------------------------------------------------------- */
/*                                   Player                                   */
/* -------------------------------------------------------------------------- */

class Player {
  /**
   * @param {Partial<typeof DEFAULT_CONFIG>} [config] Optional overrides.
   */
  constructor(config = {}) {
    /** @type {typeof DEFAULT_CONFIG} */
    this.config = { ...DEFAULT_CONFIG, ...config };

    /** @type {THREE.Scene|null} */
    this.scene = null;

    /**
     * Logical player transform. All gameplay code should read / write this
     * group. The loaded GLB is a child of this group (with a visual yaw
     * correction applied so that +Z is the character's forward).
     * @type {THREE.Group|null}
     */
    this.mesh = null;

    /** @type {THREE.Object3D|null} Raw gltf.scene (visual model only). */
    this.model = null;

    /** @type {THREE.AnimationMixer|null} */
    this.mixer = null;

    /** @type {Record<string, THREE.AnimationAction>|null} */
    this.actions = null;

    /** @type {string|null} */
    this.currentActionName = null;

    /** @type {THREE.Camera|null} Optional movement reference frame. */
    this.camera = null;

    /** @type {THREE.Vector3} Current horizontal velocity (world space). */
    this.velocity = new THREE.Vector3(0, 0, 0);

    /** @type {number} Current horizontal speed (m/s). */
    this.currentSpeed = 0;

    /** @type {boolean} Whether the player is sprinting this frame. */
    this.isRunning = false;

    /** @type {boolean} When false, joystick input is ignored. */
    this.inputEnabled = true;

    /** @type {boolean} True once the model has finished loading. */
    this.ready = false;

    /**
     * Conservative world-space collision sphere, refreshed every update().
     * @type {THREE.Sphere|null}
     */
    this.boundingSphere = null;

    /**
     * Static collider metadata derived from the loaded mesh.
     * @type {{radius:number, horizontalRadius:number, height:number,
     *         centerOffset:THREE.Vector3}|null}
     */
    this.collider = null;

    /** @type {THREE.Vector3|null} Sphere centre in mesh-local space. */
    this._collisionSphereLocalCenter = null;

    /** @type {Promise<Player>|null} Guards against double-init. */
    this._initPromise = null;

    /** @type {number} Effective analog input magnitude for the current frame. */
    this._inputMagnitude = 0;

    /* Reusable scratch objects (zero allocation per frame). */
    this._tmpDir = new THREE.Vector3();
    this._tmpCamFwd = new THREE.Vector3();
    this._tmpCamRight = new THREE.Vector3();
    this._tmpVec = new THREE.Vector3();
  }

  /* ---------------------------------------------------------------------- */
  /*                                  Init                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Load the GLB, build the animation mixer and attach the player to a scene.
   * Safe to call multiple times — repeated calls return the same promise.
   *
   * @param {THREE.Scene} scene Scene the player group should be added to.
   * @returns {Promise<Player>} Resolves once the model is ready.
   */
  init(scene) {
    if (this._initPromise) return this._initPromise;
    if (!scene || typeof scene.add !== 'function') {
      return Promise.reject(new TypeError('Player.init(scene): scene is required.'));
    }

    this.scene = scene;
    this._initPromise = this._loadAndBuild().catch((error) => {
      // Allow a retry after a failed load.
      this._initPromise = null;
      throw error;
    });
    return this._initPromise;
  }

  /**
   * Internal async loader / builder.
   * @returns {Promise<Player>}
   */
  async _loadAndBuild() {
    const gltf = await this._loadGLTF();

    /* --- 1. Prepare the visual model ---------------------------------- */
    this.model = gltf.scene;
    this.model.rotation.y = this.config.modelYawOffset;
    this.model.name = 'PlayerModel';

    this.model.traverse((object) => {
      if (object.isMesh || object.isSkinnedMesh) {
        object.castShadow = this.config.shadow;
        object.receiveShadow = this.config.shadow;
        // Skinned bounding volumes are unreliable after deformation.
        object.frustumCulled = false;

        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) {
          if (material) material.side = THREE.FrontSide;
        }
      }
    });

    /* --- 2. Build the logical transform group ------------------------- */
    this.mesh = new THREE.Group();
    this.mesh.name = 'Player';
    this.mesh.position.set(0, this.config.groundY, 0);
    this.mesh.add(this.model);
    this.scene.add(this.mesh);

    /* --- 3. Animation system ------------------------------------------ */
    this.mixer = new THREE.AnimationMixer(this.model);
    this._setupAnimations(gltf.animations);

    /* --- 4. Collision volume ------------------------------------------ */
    this._computeCollider();

    /* --- 5. Enter the Idle state immediately -------------------------- */
    this._fadeToAction('idle', 0);

    this.ready = true;
    return this;
  }

  /**
   * Try the primary CDN URL, then the fallback URL.
   * @returns {Promise<import('three/addons/loaders/GLTFLoader.js').GLTF>}
   */
  async _loadGLTF() {
    const loader = new GLTFLoader();
    const urls = [this.config.modelUrl, this.config.modelFallbackUrl].filter(Boolean);
    let lastError = null;

    for (const url of urls) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await loader.loadAsync(url);
      } catch (error) {
        lastError = error;
        console.warn(`[Player] Failed to load model from "${url}".`, error);
      }
    }

    throw lastError || new Error('[Player] Unable to load the player model.');
  }

  /* ---------------------------------------------------------------------- */
  /*                             Animation setup                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolve the Idle / Walk / Run clips and create looping actions.
   * @param {THREE.AnimationClip[]} animations
   */
  _setupAnimations(animations) {
    const clips = this._resolveClips(animations);

    this.actions = {};
    for (const name of ['idle', 'walk', 'run']) {
      const clip = clips[name];
      if (!clip) continue;

      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.enabled = true;
      this.actions[name] = action;
    }

    // Ensure the three mandatory states always exist so update() never throws.
    const fallback = this.actions.idle || Object.values(this.actions)[0] || null;
    if (fallback) {
      this.actions.idle = this.actions.idle || fallback;
      this.actions.walk = this.actions.walk || this.actions.idle;
      this.actions.run  = this.actions.run  || this.actions.walk;
    }
  }

  /**
   * Map the raw GLB animation list onto { idle, walk, run } using name
   * matching (exact -> case-insensitive -> substring) with index fallbacks.
   *
   * @param {THREE.AnimationClip[]} animations
   * @returns {{ idle: THREE.AnimationClip|null,
   *             walk: THREE.AnimationClip|null,
   *             run:  THREE.AnimationClip|null }}
   */
  _resolveClips(animations) {
    const list = Array.isArray(animations) ? animations : [];
    const resolved = { idle: null, walk: null, run: null };

    for (const state of ['idle', 'walk', 'run']) {
      const candidates = this.config.clipAliases[state] || [state];

      // 1) Exact name match.
      let clip = list.find((entry) => candidates.includes(entry.name));

      // 2) Case-insensitive match.
      if (!clip) {
        const lowered = candidates.map((name) => name.toLowerCase());
        clip = list.find((entry) => lowered.includes(entry.name.toLowerCase()));
      }

      // 3) Substring match (handles "Armature|Idle" style names).
      if (!clip) {
        const lowered = candidates.map((name) => name.toLowerCase());
        clip = list.find((entry) => {
          const n = entry.name.toLowerCase();
          return lowered.some((alias) => n.includes(alias));
        });
      }

      // 4) Index fallback (known Soldier.glb layout).
      if (!clip) {
        const index = this.config.fallbackIndices[state];
        if (Number.isInteger(index) && list[index]) clip = list[index];
      }

      resolved[state] = clip || null;
    }

    if (!resolved.idle || !resolved.walk || !resolved.run) {
      console.warn(
        '[Player] Could not resolve every animation state. Available clips:',
        list.map((clip) => clip.name),
      );
    }

    return resolved;
  }

  /**
   * Smoothly blend into a named animation state.
   * Uses fadeOut/fadeIn (the robust pattern used by the official three.js
   * RobotExpressive example) which tolerates interrupted transitions.
   *
   * @param {'idle'|'walk'|'run'} name
   * @param {number} duration Cross-fade duration in seconds.
   */
  _fadeToAction(name, duration) {
    if (!this.actions) return;

    const next = this.actions[name];
    if (!next) return;
    if (this.currentActionName === name) return;

    const previous = this.currentActionName
      ? this.actions[this.currentActionName]
      : null;

    if (previous && previous !== next) {
      previous.fadeOut(duration);
    }

    next.reset();
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    if (duration > 0) next.fadeIn(duration);
    next.play();

    this.currentActionName = name;
  }

  /**
   * Pick the correct animation state from the current speed / sprint flag and
   * keep walk / run playback rate in sync with actual ground speed to reduce
   * foot sliding.
   */
  _updateAnimationState() {
    if (!this.actions) return;

    const { idleSpeedThreshold, runSpeedThreshold } = this.config;
    const speed = this.currentSpeed;

    let next;
    if (speed < idleSpeedThreshold) {
      next = 'idle';
    } else if (this.isRunning && speed >= runSpeedThreshold) {
      next = 'run';
    } else {
      next = 'walk';
    }

    if (next !== this.currentActionName) {
      this._fadeToAction(next, this.config.animationFadeDuration);
    }

    // Foot-sync: scale the clip so the legs match the world-space speed.
    if (next === 'walk' && this.actions.walk) {
      const timeScale = THREE.MathUtils.clamp(
        speed / this.config.referenceWalkSpeed,
        0.55,
        1.7,
      );
      this.actions.walk.setEffectiveTimeScale(timeScale);
    } else if (next === 'run' && this.actions.run) {
      const timeScale = THREE.MathUtils.clamp(
        speed / this.config.referenceRunSpeed,
        0.6,
        1.5,
      );
      this.actions.run.setEffectiveTimeScale(timeScale);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                                Collision                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Derive a conservative bounding sphere + capsule-ish metadata from the
   * loaded mesh. Called once after the model is ready.
   */
  _computeCollider() {
    const box = new THREE.Box3().setFromObject(this.model);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const size = box.getSize(this._tmpVec.clone());
    const center = box.getCenter(new THREE.Vector3());

    this.collider = {
      radius: sphere.radius,
      horizontalRadius: Math.max(size.x, size.z) * 0.5,
      height: size.y,
      centerOffset: center.clone(),
    };

    // Convenience alias for quick gameplay checks.
    this.radius = sphere.radius;

    this._collisionSphereLocalCenter = center.clone();
    this.boundingSphere = sphere;
    this._updateCollisionSphere();
  }

  /**
   * Keep the world-space collision sphere in sync with the player transform.
   */
  _updateCollisionSphere() {
    if (!this.boundingSphere || !this._collisionSphereLocalCenter) return;
    this.boundingSphere.center
      .copy(this._collisionSphereLocalCenter)
      .add(this.mesh.position);
  }

  /* ---------------------------------------------------------------------- */
  /*                              Movement math                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Convert the raw joystick vector into a normalised world-space direction.
   * The effective analog magnitude is stored on `this._inputMagnitude`.
   *
   * @param {{x:number, y:number}|THREE.Vector2|THREE.Vector3|null} inputVector
   * @param {THREE.Vector3} outDir Receives the normalised direction.
   * @returns {THREE.Vector3} `outDir`
   */
  _resolveInputDirection(inputVector, outDir) {
    outDir.set(0, 0, 0);
    this._inputMagnitude = 0;

    if (!this.inputEnabled || !inputVector) return outDir;

    let ix = Number(inputVector.x) || 0;
    let iy = Number(inputVector.y) || 0;

    const rawMagnitude = Math.hypot(ix, iy);
    const deadzone = this.config.inputDeadzone;
    if (rawMagnitude <= deadzone) return outDir;

    // Rescale so the dead-zone edge maps to 0 and the rim maps to 1.
    const effectiveMagnitude = Math.min(
      1,
      (rawMagnitude - deadzone) / (1 - deadzone),
    );

    // Normalise the stick axes.
    ix /= rawMagnitude;
    iy /= rawMagnitude;

    if (this.camera) {
      // Camera-relative movement: project the camera look direction onto XZ.
      this.camera.getWorldDirection(this._tmpCamFwd);
      this._tmpCamFwd.y = 0;
      if (this._tmpCamFwd.lengthSq() < 1e-8) {
        this._tmpCamFwd.set(0, 0, -1);
      }
      this._tmpCamFwd.normalize();

      // right = forward × up
      this._tmpCamRight.crossVectors(this._tmpCamFwd, WORLD_UP).normalize();

      outDir.x = this._tmpCamFwd.x * iy + this._tmpCamRight.x * ix;
      outDir.z = this._tmpCamFwd.z * iy + this._tmpCamRight.z * ix;
    } else {
      // World-space input: x -> world X, y -> world Z.
      outDir.x = ix;
      outDir.z = iy;
    }

    const length = Math.hypot(outDir.x, outDir.z);
    if (length < 1e-6) {
      outDir.set(0, 0, 0);
      return outDir;
    }

    outDir.x /= length;
    outDir.z /= length;
    outDir.y = 0;

    this._inputMagnitude = effectiveMagnitude;
    return outDir;
  }

  /**
   * Shortest-path exponential damping for angles (radians).
   * @param {number} current
   * @param {number} target
   * @param {number} lambda
   * @param {number} dt
   * @returns {number}
   */
  _dampAngle(current, target, lambda, dt) {
    const delta = Math.atan2(
      Math.sin(target - current),
      Math.cos(target - current),
    );
    return current + delta * (1 - Math.exp(-lambda * dt));
  }

  /**
   * Apply acceleration, friction, integration and directional rotation for a
   * single frame.
   *
   * @param {number} dt Clamped delta time.
   * @param {object|null} inputVector
   * @param {boolean} isRunning
   */
  _updateMovement(dt, inputVector, isRunning) {
    const dir = this._resolveInputDirection(inputVector, this._tmpDir);
    const magnitude = this._inputMagnitude;

    const maxSpeed = isRunning ? this.config.runSpeed : this.config.walkSpeed;
    const targetSpeed = magnitude * maxSpeed;

    const desiredX = dir.x * targetSpeed;
    const desiredZ = dir.z * targetSpeed;

    // Choose acceleration vs. deceleration lambda.
    const currentSpeedSq =
      this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    const desiredSpeedSq = desiredX * desiredX + desiredZ * desiredZ;
    const lambda = desiredSpeedSq > currentSpeedSq
      ? this.config.acceleration
      : this.config.deceleration;

    const factor = 1 - Math.exp(-lambda * dt);
    this.velocity.x += (desiredX - this.velocity.x) * factor;
    this.velocity.z += (desiredZ - this.velocity.z) * factor;

    // Hard cap so external impulses can never exceed the sprint speed.
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const hardCap = this.config.runSpeed * this.config.maxSpeedMultiplier;
    if (speed > hardCap && speed > 1e-6) {
      const scale = hardCap / speed;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }

    // Integrate horizontal position; feet stay locked to the ground plane.
    const position = this.mesh.position;
    position.x += this.velocity.x * dt;
    position.z += this.velocity.z * dt;
    position.y = this.config.groundY;

    // Directional rotation — the character turns to face the joystick.
    if (magnitude > 0 && (dir.x !== 0 || dir.z !== 0)) {
      const targetYaw = Math.atan2(dir.x, dir.z);
      this.mesh.rotation.y = this._dampAngle(
        this.mesh.rotation.y,
        targetYaw,
        this.config.rotationLambda,
        dt,
      );
    }

    this.currentSpeed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  /* ---------------------------------------------------------------------- */
  /*                              Public update                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the player simulation by one frame.
   *
   * @param {number} deltaTime Seconds since the previous frame.
   * @param {{x:number, y:number}|THREE.Vector2|THREE.Vector3|null} inputVector
   *        Joystick / movement input. `.x` = strafe, `.y` = forward.
   * @param {boolean} [isRunning=false] Sprint flag.
   */
  update(deltaTime, inputVector, isRunning = false) {
    if (!this.ready || !this.mesh) return;

    const dt = Math.min(
      Math.max(Number(deltaTime) || 0, 0),
      this.config.maxDeltaTime,
    );
    if (dt <= 0) return;

    this.isRunning = Boolean(isRunning);

    this._updateMovement(dt, inputVector, this.isRunning);
    this._updateAnimationState();

    if (this.mixer) this.mixer.update(dt);

    this._updateCollisionSphere();
  }

  /* ---------------------------------------------------------------------- */
  /*                                Accessors                               */
  /* ---------------------------------------------------------------------- */

  /**
   * @returns {THREE.Vector3} Live world-space position reference.
   */
  getPosition() {
    return this.mesh ? this.mesh.position : this._tmpVec.set(0, 0, 0);
  }

  /**
   * @returns {THREE.Group|null} The logical player transform group.
   */
  getMesh() {
    return this.mesh;
  }

  /**
   * @returns {THREE.Vector3} Live world-space velocity reference.
   */
  getVelocity() {
    return this.velocity;
  }

  /**
   * @returns {number} Current horizontal speed in metres / second.
   */
  getSpeed() {
    return this.currentSpeed;
  }

  /**
   * @returns {THREE.Sphere|null} Live world-space collision sphere.
   */
  getBoundingSphere() {
    return this.boundingSphere;
  }

  /**
   * @returns {typeof this.collider} Static collider metadata.
   */
  getCollider() {
    return this.collider;
  }

  /**
   * Attach a camera so joystick input is interpreted relative to the camera's
   * yaw. Pass `null` to fall back to world-space input.
   *
   * @param {THREE.Camera|null} camera
   */
  setCamera(camera) {
    this.camera = camera || null;
  }

  /**
   * Enable or disable all joystick input (e.g. while a menu is open).
   * @param {boolean} enabled
   */
  setInputEnabled(enabled) {
    this.inputEnabled = Boolean(enabled);
  }

  /**
   * Instantly move the player to a world-space position.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  setPosition(x, y = this.config.groundY, z = 0) {
    if (!this.mesh) return;
    this.mesh.position.set(x, y, z);
    this._updateCollisionSphere();
  }

  /* ---------------------------------------------------------------------- */
  /*                                 Cleanup                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Remove the player from the scene and release GPU / animation resources.
   */
  dispose() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
    }

    if (this.mesh && this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }

    if (this.model) {
      this.model.traverse((object) => {
        if (object.isMesh || object.isSkinnedMesh) {
          if (object.geometry) object.geometry.dispose();
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
          for (const material of materials) {
            if (material) material.dispose();
          }
        }
      });
    }

    this.mixer = null;
    this.actions = null;
    this.model = null;
    this.mesh = null;
    this.boundingSphere = null;
    this.collider = null;
    this._collisionSphereLocalCenter = null;
    this.currentActionName = null;
    this.ready = false;
    this._initPromise = null;
    this.velocity.set(0, 0, 0);
    this.currentSpeed = 0;
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Exports                                  */
/* -------------------------------------------------------------------------- */

export { Player };
export default Player;
