// js/weapons.js
// =============================================================================
// Modular Weapon System for PUBG-style Mobile Game
// ES6 Module – Three.js WebGL
// =============================================================================

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/loaders/GLTFLoader.js';

// =============================================================================
// 1. PROCEDURAL AUDIO ENGINE (Web Audio API)
// =============================================================================

class GunAudioEngine {
    constructor() {
        /** @type {AudioContext|null} */
        this.ctx = null;
        /** @type {GainNode|null} */
        this.masterGain = null;
        /** @type {ConvolverNode|null} */
        this.reverb = null;
        /** @type {boolean} */
        this.initialized = false;
    }

    /**
     * Initialize the audio context on first user gesture.
     * @returns {void}
     */
    init() {
        if (this.initialized) return;
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0.7;
            this.masterGain.connect(this.ctx.destination);

            // Simple reverb impulse for spatial feel
            const sampleRate = this.ctx.sampleRate;
            const length = sampleRate * 0.15; // 150ms tail
            const impulse = this.ctx.createBuffer(2, length, sampleRate);
            for (let ch = 0; ch < 2; ch++) {
                const data = impulse.getChannelData(ch);
                for (let i = 0; i < length; i++) {
                    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.5);
                }
            }
            this.reverb = this.ctx.createConvolver();
            this.reverb.buffer = impulse;
            const reverbGain = this.ctx.createGain();
            reverbGain.gain.value = 0.25;
            this.reverb.connect(reverbGain);
            reverbGain.connect(this.masterGain);

            this.initialized = true;
        } catch (e) {
            console.warn('[GunAudioEngine] Web Audio API not available:', e);
        }
    }

    /**
     * Synthesize a realistic gunshot.
     * @param {number} volume - 0..1
     * @param {number} pan - -1 (left) .. 1 (right)
     */
    playGunshot(volume = 1.0, pan = 0.0) {
        if (!this.initialized || !this.ctx) return;

        const now = this.ctx.currentTime;

        // --- 1. Transient "crack" (high-frequency noise burst) ---
        const crackLength = Math.floor(this.ctx.sampleRate * 0.04);
        const crackBuffer = this.ctx.createBuffer(1, crackLength, this.ctx.sampleRate);
        const crackData = crackBuffer.getChannelData(0);
        for (let i = 0; i < crackLength; i++) {
            const t = i / crackLength;
            crackData[i] = (Math.random() * 2 - 1) * Math.exp(-t * 18);
        }
        const crackSource = this.ctx.createBufferSource();
        crackSource.buffer = crackBuffer;

        const crackHighpass = this.ctx.createBiquadFilter();
        crackHighpass.type = 'highpass';
        crackHighpass.frequency.value = 1800;
        crackHighpass.Q.value = 0.7;

        const crackGain = this.ctx.createGain();
        crackGain.gain.setValueAtTime(0.9 * volume, now);
        crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

        crackSource.connect(crackHighpass);
        crackHighpass.connect(crackGain);
        crackGain.connect(this.masterGain);
        crackSource.start(now);
        crackSource.stop(now + 0.1);

        // --- 2. Body "boom" (low-frequency sine sweep) ---
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(120, now);
        osc.frequency.exponentialRampToValueAtTime(35, now + 0.15);

        const oscGain = this.ctx.createGain();
        oscGain.gain.setValueAtTime(0.8 * volume, now);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

        osc.connect(oscGain);
        oscGain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.22);

        // --- 3. Noise tail (residual explosion) ---
        const tailLength = Math.floor(this.ctx.sampleRate * 0.25);
        const tailBuffer = this.ctx.createBuffer(1, tailLength, this.ctx.sampleRate);
        const tailData = tailBuffer.getChannelData(0);
        for (let i = 0; i < tailLength; i++) {
            const t = i / tailLength;
            tailData[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2);
        }
        const tailSource = this.ctx.createBufferSource();
        tailSource.buffer = tailBuffer;

        const tailFilter = this.ctx.createBiquadFilter();
        tailFilter.type = 'lowpass';
        tailFilter.frequency.setValueAtTime(3000, now);
        tailFilter.frequency.exponentialRampToValueAtTime(400, now + 0.25);

        const tailGain = this.ctx.createGain();
        tailGain.gain.setValueAtTime(0.5 * volume, now);
        tailGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

        const panner = this.ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));

        tailSource.connect(tailFilter);
        tailFilter.connect(tailGain);
        tailGain.connect(panner);
        panner.connect(this.masterGain);
        panner.connect(this.reverb); // send to reverb
        tailSource.start(now);
        tailSource.stop(now + 0.3);
    }

    /**
     * Play a short metallic "click" for empty mag or reload.
     */
    playClick() {
        if (!this.initialized || !this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(1800, now);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.03);
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.06);
    }
}

// =============================================================================
// 2. MUZZLE FLASH & PARTICLE SYSTEM
// =============================================================================

class MuzzleFlash {
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.Object3D} parent - Typically the weapon mesh.
     * @param {THREE.Vector3} localPosition - Muzzle tip offset in parent space.
     */
    constructor(scene, parent, localPosition = new THREE.Vector3(0, 0, 1.2)) {
        this.scene = scene;
        this.parent = parent;
        this.localPosition = localPosition.clone();

        // --- Point light burst ---
        this.light = new THREE.PointLight(0xffaa33, 0, 8, 2);
        this.light.position.copy(this.localPosition);
        this.parent.add(this.light);

        // --- Sprite flash ---
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        gradient.addColorStop(0, 'rgba(255,255,220,1)');
        gradient.addColorStop(0.3, 'rgba(255,200,50,0.9)');
        gradient.addColorStop(0.7, 'rgba(255,100,10,0.4)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 64, 64);
        const texture = new THREE.CanvasTexture(canvas);

        this.spriteMaterial = new THREE.SpriteMaterial({
            map: texture,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
            opacity: 0,
        });
        this.sprite = new THREE.Sprite(this.spriteMaterial);
        this.sprite.scale.set(0.6, 0.6, 1);
        this.sprite.position.copy(this.localPosition);
        this.parent.add(this.sprite);

        // --- Particle sparks ---
        this.sparkCount = 12;
        this.sparkPool = [];
        this.sparkGeometry = new THREE.BufferGeometry();
        const positions = new Float32Array(this.sparkCount * 3);
        this.sparkGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.sparkMaterial = new THREE.PointsMaterial({
            color: 0xffcc44,
            size: 0.04,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
            opacity: 0,
        });
        this.sparkPoints = new THREE.Points(this.sparkGeometry, this.sparkMaterial);
        this.sparkPoints.position.copy(this.localPosition);
        this.parent.add(this.sparkPoints);

        // Internal state
        this.flashTimer = 0;
        this.flashDuration = 0.06;
        this.visible = false;

        // Hide initially
        this._setVisible(false);
    }

    /**
     * Trigger a muzzle flash.
     */
    trigger() {
        this.flashTimer = this.flashDuration;
        this.visible = true;
        this._setVisible(true);
        this._randomizeSparks();
    }

    /**
     * Update flash fade.
     * @param {number} dt - Delta time in seconds.
     */
    update(dt) {
        if (!this.visible) return;
        this.flashTimer -= dt;
        if (this.flashTimer <= 0) {
            this.visible = false;
            this._setVisible(false);
            return;
        }

        const t = this.flashTimer / this.flashDuration; // 1 -> 0
        const intensity = Math.sin(t * Math.PI); // smooth pulse

        this.light.intensity = intensity * 3.5;
        this.spriteMaterial.opacity = intensity;
        this.sprite.scale.setScalar(0.4 + intensity * 0.5);
        this.sparkMaterial.opacity = intensity;

        // Animate sparks outward
        const posAttr = this.sparkGeometry.attributes.position;
        for (let i = 0; i < this.sparkCount; i++) {
            const idx = i * 3;
            posAttr.array[idx] += this.sparkPool[i].x * dt * 8;
            posAttr.array[idx + 1] += this.sparkPool[i].y * dt * 8;
            posAttr.array[idx + 2] += this.sparkPool[i].z * dt * 8;
        }
        posAttr.needsUpdate = true;
    }

    /**
     * @private
     */
    _setVisible(v) {
        this.light.intensity = v ? 3.5 : 0;
        this.spriteMaterial.opacity = v ? 1 : 0;
        this.sparkMaterial.opacity = v ? 1 : 0;
    }

    /**
     * @private
     */
    _randomizeSparks() {
        const posAttr = this.sparkGeometry.attributes.position;
        this.sparkPool = [];
        for (let i = 0; i < this.sparkCount; i++) {
            const idx = i * 3;
            posAttr.array[idx] = 0;
            posAttr.array[idx + 1] = 0;
            posAttr.array[idx + 2] = 0;

            const dir = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2 + 1
            ).normalize();
            this.sparkPool.push(dir);
        }
        posAttr.needsUpdate = true;
    }
}

// =============================================================================
// 3. BULLET TRACER SYSTEM
// =============================================================================

class TracerSystem {
    /**
     * @param {THREE.Scene} scene
     */
    constructor(scene) {
        this.scene = scene;
        this.tracers = [];
        this.maxTracers = 30;
    }

    /**
     * Spawn a tracer line from start to end.
     * @param {THREE.Vector3} start
     * @param {THREE.Vector3} end
     */
    spawn(start, end) {
        const geometry = new THREE.BufferGeometry().setFromPoints([start.clone(), end.clone()]);
        const material = new THREE.LineBasicMaterial({
            color: 0xffdd44,
            transparent: true,
            opacity: 0.9,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const line = new THREE.Line(geometry, material);
        this.scene.add(line);

        this.tracers.push({
            line,
            life: 0.08,
            maxLife: 0.08,
        });

        // Cull oldest if over limit
        if (this.tracers.length > this.maxTracers) {
            const old = this.tracers.shift();
            this.scene.remove(old.line);
            old.line.geometry.dispose();
            old.line.material.dispose();
        }
    }

    /**
     * @param {number} dt
     */
    update(dt) {
        for (let i = this.tracers.length - 1; i >= 0; i--) {
            const t = this.tracers[i];
            t.life -= dt;
            if (t.life <= 0) {
                this.scene.remove(t.line);
                t.line.geometry.dispose();
                t.line.material.dispose();
                this.tracers.splice(i, 1);
            } else {
                t.line.material.opacity = (t.life / t.maxLife) * 0.9;
            }
        }
    }
}

// =============================================================================
// 4. MAIN WEAPON CLASS
// =============================================================================

export class Weapon {
    /**
     * @param {object} [options]
     * @param {string} [options.modelUrl] - GLB model URL.
     * @param {THREE.Scene} [options.scene] - Scene to add effects to.
     */
    constructor(options = {}) {
        // Configuration
        this.config = {
            modelUrl: options.modelUrl || 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r165/examples/models/gltf/rifle.glb',
            fireRate: 600,          // rounds per minute
            magSize: 30,
            reserveAmmo: 120,
            reloadTime: 2.2,        // seconds
            adsFov: 35,             // Field of view when aiming
            hipFov: 75,             // Default FOV
            adsSpeed: 8.0,          // ADS transition speed
            recoilAmount: 0.025,    // camera kick in radians
            recoilRecovery: 12.0,   // recovery speed
            tracerRange: 500,
        };

        // State
        this.mesh = null;               // THREE.Group for the weapon
        this.muzzlePoint = null;        // Empty object at barrel tip
        this.ammoInMag = this.config.magSize;
        this.reserveAmmo = this.config.reserveAmmo;
        this.isReloading = false;
        this.reloadTimer = 0;
        this.lastShotTime = 0;
        this.isADS = false;
        this.currentFov = this.config.hipFov;

        // Recoil
        this.recoilOffset = 0;          // current backward offset
        this.recoilVelocity = 0;

        // Audio
        this.audio = new GunAudioEngine();

        // FX
        this.muzzleFlash = null;
        this.tracerSystem = null;

        // Player attachment
        this.playerMesh = null;
        this.attachedBone = null;
        this.originalParent = null;
        this.originalPosition = new THREE.Vector3();
        this.originalQuaternion = new THREE.Quaternion();

        // Bindings
        this._raycaster = new THREE.Raycaster();

        // Load model
        this._loadModel();
    }

    // -------------------------------------------------------------------------
    // 4.1 MODEL LOADING
    // -------------------------------------------------------------------------

    /**
     * @private
     */
    _loadModel() {
        this.mesh = new THREE.Group();
        this.mesh.name = 'Weapon_Root';

        const loader = new GLTFLoader();
        loader.load(
            this.config.modelUrl,
            (gltf) => {
                const model = gltf.scene;
                model.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = false;
                    }
                });

                // Normalize scale – many GLB rifles are huge or tiny.
                const box = new THREE.Box3().setFromObject(model);
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);
                if (maxDim > 0.01) {
                    const targetLength = 0.9; // ~90cm rifle
                    const scale = targetLength / maxDim;
                    model.scale.setScalar(scale);
                }

                // Center the model around origin
                const center = box.getCenter(new THREE.Vector3());
                model.position.sub(center.multiplyScalar(model.scale.x));

                this.mesh.add(model);
                this._createMuzzlePoint(model);
                this._setupEffects();
                console.log('[Weapon] Model loaded successfully.');
            },
            undefined,
            (err) => {
                console.warn('[Weapon] Failed to load GLB model, using procedural fallback.', err);
                this._createProceduralRifle();
                this._setupEffects();
            }
        );
    }

    /**
     * Create an empty object at the barrel tip for muzzle flash/tracer origin.
     * @private
     */
    _createMuzzlePoint(model) {
        this.muzzlePoint = new THREE.Object3D();
        // Approximate barrel tip: front of the bounding box
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        // Barrel tip is at +Z (forward) in most rifle models
        const tipZ = box.max.z;
        this.muzzlePoint.position.set(0, 0, tipZ + 0.05);
        this.mesh.add(this.muzzlePoint);
    }

    /**
     * Procedural fallback rifle built from basic shapes.
     * @private
     */
    _createProceduralRifle() {
        // Receiver
        const receiverGeo = new THREE.BoxGeometry(0.06, 0.08, 0.5);
        const receiverMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.7 });
        const receiver = new THREE.Mesh(receiverGeo, receiverMat);
        receiver.position.set(0, 0, 0.2);
        this.mesh.add(receiver);

        // Barrel
        const barrelGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.45, 8);
        const barrelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4, metalness: 0.9 });
        const barrel = new THREE.Mesh(barrelGeo, barrelMat);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.01, 0.55);
        this.mesh.add(barrel);

        // Stock
        const stockGeo = new THREE.BoxGeometry(0.05, 0.07, 0.25);
        const stockMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 });
        const stock = new THREE.Mesh(stockGeo, stockMat);
        stock.position.set(0, -0.01, -0.1);
        this.mesh.add(stock);

        // Magazine
        const magGeo = new THREE.BoxGeometry(0.04, 0.12, 0.06);
        const magMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
        const mag = new THREE.Mesh(magGeo, magMat);
        mag.position.set(0, -0.1, 0.1);
        mag.rotation.x = 0.15;
        this.mesh.add(mag);

        // Grip
        const gripGeo = new THREE.BoxGeometry(0.04, 0.1, 0.05);
        const gripMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
        const grip = new THREE.Mesh(gripGeo, gripMat);
        grip.position.set(0, -0.09, -0.05);
        grip.rotation.x = -0.2;
        this.mesh.add(grip);

        // Muzzle point
        this.muzzlePoint = new THREE.Object3D();
        this.muzzlePoint.position.set(0, 0.01, 0.8);
        this.mesh.add(this.muzzlePoint);

        console.log('[Weapon] Procedural rifle created.');
    }

    /**
     * @private
     */
    _setupEffects() {
        // Muzzle flash (added as child of mesh)
        if (this.muzzlePoint) {
            this.muzzleFlash = new MuzzleFlash(
                null, // scene not needed for light since it's child of mesh
                this.mesh,
                this.muzzlePoint.position.clone()
            );
        }
    }

    /**
     * Attach the weapon to a player mesh / hand bone.
     * @param {THREE.Object3D} playerMesh - The player's skinned mesh or root object.
     * @param {string} [handBoneName='RightHand'] - Name of the hand bone.
     */
    attachToPlayer(playerMesh, handBoneName = 'RightHand') {
        if (!this.mesh) {
            console.warn('[Weapon] Mesh not ready yet.');
            return;
        }

        this.playerMesh = playerMesh;

        // Try to find the hand bone
        let handBone = null;
        playerMesh.traverse((child) => {
            if (child.isBone && child.name.toLowerCase().includes(handBoneName.toLowerCase())) {
                handBone = child;
            }
        });

        // Fallback: search common bone names
        if (!handBone) {
            const commonNames = ['RightHand', 'mixamorigRightHand', 'Bip01_R_Hand', 'hand_r', 'Hand_R'];
            for (const name of commonNames) {
                playerMesh.traverse((child) => {
                    if (child.isBone && child.name === name) {
                        handBone = child;
                    }
                });
                if (handBone) break;
            }
        }

        // If no bone found, attach to player root
        const parent = handBone || playerMesh;
        this.attachedBone = handBone;
        this.originalParent = this.mesh.parent;

        // Save original transform
        this.originalPosition.copy(this.mesh.position);
        this.originalQuaternion.copy(this.mesh.quaternion);

        // Attach
        parent.add(this.mesh);

        // Reset local transform for hand attachment
        this.mesh.position.set(0, 0, 0);
        this.mesh.quaternion.identity();

        // Adjust scale/rotation for hand attachment
        const box = new THREE.Box3().setFromObject(this.mesh);
        const size = box.getSize(new THREE.Vector3());
        if (size.length() > 2) {
            // Model is too large, scale down
            this.mesh.scale.setScalar(0.4);
        }

        // Rotate rifle to point forward relative to hand
        this.mesh.rotation.set(0, Math.PI / 2, 0);

        console.log('[Weapon] Attached to', handBone ? `bone "${handBone.name}"` : 'player root');
    }

    /**
     * Detach from player and return to original parent.
     */
    detachFromPlayer() {
        if (this.originalParent) {
            this.originalParent.add(this.mesh);
            this.mesh.position.copy(this.originalPosition);
            this.mesh.quaternion.copy(this.originalQuaternion);
        }
        this.playerMesh = null;
        this.attachedBone = null;
    }

    // -------------------------------------------------------------------------
    // 4.2 FIRING MECHANICS
    // -------------------------------------------------------------------------

    /**
     * Attempt to fire the weapon.
     * @param {THREE.Scene} scene - The scene (for tracers).
     * @param {THREE.Camera} camera - Used for aiming direction.
     * @returns {boolean} True if a shot was fired.
     */
    shoot(scene, camera) {
        const now = performance.now() / 1000;
        const fireInterval = 60 / this.config.fireRate;

        // Rate-of-fire check
        if (now - this.lastShotTime < fireInterval) return false;

        // Reload check
        if (this.isReloading) {
            this.audio.playClick();
            return false;
        }

        // Ammo check
        if (this.ammoInMag <= 0) {
            this.audio.playClick();
            this._autoReload();
            return false;
        }

        // Consume ammo
        this.ammoInMag--;
        this.lastShotTime = now;

        // --- Audio ---
        this.audio.init();
        // Compute pan based on player relative to camera (simplified)
        const pan = 0.0;
        this.audio.playGunshot(1.0, pan);

        // --- Muzzle Flash ---
        if (this.muzzleFlash) {
            this.muzzleFlash.trigger();
        }

        // --- Bullet Tracer ---
        this._spawnTracer(scene, camera);

        // --- Recoil ---
        this.applyRecoil();

        return true;
    }

    /**
     * @private
     */
    _spawnTracer(scene, camera) {
        if (!this.tracerSystem) {
            this.tracerSystem = new TracerSystem(scene);
        }
        if (!this.muzzlePoint) return;

        // Muzzle world position
        const muzzleWorld = new THREE.Vector3();
        this.muzzlePoint.getWorldPosition(muzzleWorld);

        // Direction from camera through center of screen (crosshair)
        const rayOrigin = camera.position.clone();
        const rayDir = new THREE.Vector3(0, 0, -1);
        rayDir.applyQuaternion(camera.quaternion);
        rayDir.normalize();

        // Raycast to find hit point
        this._raycaster.set(rayOrigin, rayDir);
        const hits = this._raycaster.intersectObjects(scene.children, true);
        let endPoint;
        if (hits.length > 0) {
            endPoint = hits[0].point.clone();
        } else {
            endPoint = rayOrigin.clone().add(rayDir.multiplyScalar(this.config.tracerRange));
        }

        this.tracerSystem.spawn(muzzleWorld, endPoint);
    }

    // -------------------------------------------------------------------------
    // 4.3 RECOIL
    // -------------------------------------------------------------------------

    /**
     * Apply a backward recoil impulse to the weapon mesh.
     */
    applyRecoil() {
        this.recoilVelocity += this.config.recoilAmount * 60; // impulse
    }

    /**
     * @private
     */
    _updateRecoil(dt) {
        if (Math.abs(this.recoilVelocity) < 0.001 && Math.abs(this.recoilOffset) < 0.001) {
            this.recoilOffset = 0;
            this.recoilVelocity = 0;
            return;
        }

        // Spring-damper system
        const springK = 250; // stiffness
        const damping = 18;  // damping
        const acceleration = -springK * this.recoilOffset - damping * this.recoilVelocity;
        this.recoilVelocity += acceleration * dt;
        this.recoilOffset += this.recoilVelocity * dt;
    }

    // -------------------------------------------------------------------------
    // 4.4 ADS (AIM DOWN SIGHTS)
    // -------------------------------------------------------------------------

    /**
     * Toggle ADS mode.
     */
    toggleADS() {
        this.isADS = !this.isADS;
    }

    /**
     * Set ADS state explicitly.
     * @param {boolean} active
     */
    setADS(active) {
        this.isADS = active;
    }

    /**
     * @private
     */
    _updateADS(dt) {
        const targetFov = this.isADS ? this.config.adsFov : this.config.hipFov;
        const speed = this.config.adsSpeed;
        this.currentFov += (targetFov - this.currentFov) * Math.min(1, speed * dt);
    }

    // -------------------------------------------------------------------------
    // 4.5 AMMO & RELOAD
    // -------------------------------------------------------------------------

    /**
     * Start reload if possible.
     */
    reload() {
        if (this.isReloading) return;
        if (this.ammoInMag >= this.config.magSize) return;
        if (this.reserveAmmo <= 0) {
            this.audio.playClick();
            return;
        }

        this.isReloading = true;
        this.reloadTimer = this.config.reloadTime;
        this.audio.playClick();
    }

    /**
     * @private
     */
    _autoReload() {
        this.reload();
    }

    /**
     * @private
     */
    _updateReload(dt) {
        if (!this.isReloading) return;

        this.reloadTimer -= dt;
        if (this.reloadTimer <= 0) {
            this.isReloading = false;
            const needed = this.config.magSize - this.ammoInMag;
            const available = Math.min(needed, this.reserveAmmo);
            this.ammoInMag += available;
            this.reserveAmmo -= available;
        }
    }

    /**
     * Get current ammo status.
     * @returns {{ inMag: number, reserve: number, isReloading: boolean }}
     */
    getAmmoStatus() {
        return {
            inMag: this.ammoInMag,
            reserve: this.reserveAmmo,
            isReloading: this.isReloading,
        };
    }

    // -------------------------------------------------------------------------
    // 4.6 UPDATE LOOP
    // -------------------------------------------------------------------------

    /**
     * Call every frame.
     * @param {number} dt - Delta time in seconds.
     * @param {THREE.Camera} [camera]
     */
    update(dt, camera) {
        if (!this.mesh) return;

        // Muzzle flash
        if (this.muzzleFlash) {
            this.muzzleFlash.update(dt);
        }

        // Tracer fade
        if (this.tracerSystem) {
            this.tracerSystem.update(dt);
        }

        // Recoil
        this._updateRecoil(dt);

        // ADS FOV
        this._updateADS(dt);
        if (camera) {
            camera.fov = this.currentFov;
            camera.updateProjectionMatrix();
        }

        // Reload timer
        this._updateReload(dt);

        // Apply recoil offset to mesh position (local space)
        if (this.mesh) {
            // Base position (from attachment or original)
            const basePos = this.attachedBone
                ? new THREE.Vector3(0, 0, 0)
                : this.originalPosition.clone();

            // Apply recoil backward (along local -Z or +Z depending on model orientation)
            // Assume rifle points along +Z, so recoil pushes along -Z
            const recoilOffsetVec = new THREE.Vector3(0, 0, -this.recoilOffset);
            this.mesh.position.copy(basePos).add(recoilOffsetVec);
        }
    }

    // -------------------------------------------------------------------------
    // 4.7 UTILITY
    // -------------------------------------------------------------------------

    /**
     * Check if weapon is ready to fire.
     * @returns {boolean}
     */
    canFire() {
        if (this.isReloading) return false;
        if (this.ammoInMag <= 0) return false;
        const now = performance.now() / 1000;
        const fireInterval = 60 / this.config.fireRate;
        return (now - this.lastShotTime) >= fireInterval;
    }

    /**
     * Get the weapon's 3D group.
     * @returns {THREE.Group|null}
     */
    getMesh() {
        return this.mesh;
    }

    /**
     * Dispose of all resources.
     */
    dispose() {
        if (this.mesh) {
            this.mesh.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach((m) => m.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            });
            if (this.mesh.parent) {
                this.mesh.parent.remove(this.mesh);
            }
        }
        if (this.tracerSystem) {
            this.tracerSystem.tracers.forEach((t) => {
                this.tracerSystem.scene.remove(t.line);
                t.line.geometry.dispose();
                t.line.material.dispose();
            });
        }
        this.audio.ctx?.close();
    }
}

// =============================================================================
// EXPORT
// =============================================================================

export default Weapon;
