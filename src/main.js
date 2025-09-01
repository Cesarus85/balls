// --- Imports via Import-Map (siehe index.html) ---
import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// ==============================
// Konfiguration (optimiert)
// ==============================
const USE_SIMPLE_VIZ = false;

// Sichtbare Debug-Meshes AUS (kein weißes Drahtgitter mehr)
const ENABLE_MESH_DEBUG = false;

// Raum-Mesh Limits/Filter
const MAX_MESHES = 40;                 // max. aktive XR-Meshes
const MAX_TRIANGLES_PER_MESH = 3000;   // Tri-Cap pro Mesh (Downsampling)
const MAX_MESH_DISTANCE = 6.5;         // m – Distanz-Culling (mit Radius-Puffer)
const DETECTED_MESH_UPDATE_RATE = 2;   // nur jeden 2. Frame verarbeiten

// Optionaler Semantik-Filter (robust: nur anwenden, wenn Label vorhanden)
const ACCEPT_SEMANTICS = ['floor','wall','ceiling','vertical','vertical_surface','table'];

// Physik/Solver
const FIXED_DT = 1 / 60;
const SOLVER_ITER = 7;
const SOLVER_TOL  = 0.001;

// Bälle
const BALL_RADIUS   = 0.02;
const BALL_MASS     = 0.003;
const BALL_SPEED    = 3.5;
const BALL_LIMIT    = 200;
const BALL_LIFETIME = 20 * 1000;
const BALL_SPAWN_OFFSET = 0.22;
const BALL_NO_COLLISION_MS = 60; // kürzer, damit nicht „durch“ fliegt

// UI
const RAYCAST_INTERVAL_MS = 33;        // ~30 Hz Hover

// Mesh-Kollisionen Toggle
let meshCollisionsEnabled = true;

// ==============================
// Renderer / Scene / Camera
// ==============================
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.setClearAlpha(0);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

// Licht
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(1, 2, 1);
scene.add(dir);

// Boden-Grid
const grid = new THREE.GridHelper(4, 8, 0x888888, 0x444444);
grid.material.opacity = 0.25;
grid.material.transparent = true;
scene.add(grid);

// ==============================
// AR-Session
// ==============================
const sessionInit = {
  optionalFeatures: [
    'local-floor','bounded-floor',
    'hit-test','anchors','dom-overlay','hand-tracking',
    'mesh-detection'
  ],
  domOverlay: { root: document.body }
};

if (!('xr' in navigator)) showHint('⚠️ WebXR nicht verfügbar. Bitte auf der Quest im Meta-Browser per HTTPS öffnen.');
const arBtn = ARButton.createButton(renderer, sessionInit);
document.body.appendChild(arBtn);

let xrSession = null, viewerSpace = null, refSpace = null, hitTestSource = null;
let xrActive = false;

// ==============================
// Physik (CANNON) – schnell & stabil
// ==============================
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world); // schnellere Broadphase
world.allowSleep = true;                             // Schlafen erlauben
world.solver.iterations = SOLVER_ITER;
world.solver.tolerance  = SOLVER_TOL;

const matBall  = new CANNON.Material('ball');
const matWorld = new CANNON.Material('world');
world.defaultContactMaterial.contactEquationStiffness = 1e7;
world.defaultContactMaterial.contactEquationRelaxation = 3;
world.addContactMaterial(new CANNON.ContactMaterial(matBall, matWorld, {
  friction: 0.35, restitution: 0.6
}));

// Boden-Plane
const groundBody = new CANNON.Body({ mass: 0, material: matWorld });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
groundBody.position.set(0, 0, 0);
world.addBody(groundBody);
grid.position.y = 0;

// ==============================
// Reticle
// ==============================
const reticleGeo = new THREE.RingGeometry(0.06, 0.08, 32);
reticleGeo.rotateX(-Math.PI / 2);
const reticleMat = new THREE.MeshBasicMaterial({ color: 0x40ff88, transparent: true, opacity: 0.9 });
const reticle = new THREE.Mesh(reticleGeo, reticleMat);
reticle.visible = false;
scene.add(reticle);

let floorLocked = false;
let lastHitPose = null;

// ==============================
// UI: Schild + Panel (🧹 / 🧱)
// ==============================
let signMesh, setSignText;
({ signMesh, setSignText } = createBillboardSign(
  "👀 Schaue auf den Boden und platziere das Reticle.\nDrücke den TRIGGER der LINKEN Hand, um die Bodenhöhe zu setzen."
));
signMesh.visible = false;
scene.add(signMesh);

// Panel mit 2 Buttons
const uiRoot = new THREE.Group();
uiRoot.visible = false; // per Menütaste togglen
scene.add(uiRoot);

const { buttonRoot: clearBtnRoot, buttonFront: clearBtnFront, setButtonState: setClearBtnState } = createClearBallsButton();
uiRoot.add(clearBtnRoot);

const { toggleRoot: meshBtnRoot, toggleFront: meshBtnFront, setToggleVisual } = createMeshToggleButton();
uiRoot.add(meshBtnRoot);

clearBtnRoot.position.x = -0.09;
meshBtnRoot.position.x  =  0.09;

let interactive = [clearBtnFront, meshBtnFront];

const raycaster = new THREE.Raycaster();
let hovered = null;
let lastRayTs = 0;

// ==============================
// Controller / Eingaben
// ==============================
const controller0 = renderer.xr.getController(0);
const controller1 = renderer.xr.getController(1);
scene.add(controller0, controller1);

const controllerGrip0 = renderer.xr.getControllerGrip(0);
const controllerGrip1 = renderer.xr.getControllerGrip(1);

function addSimpleControllerViz(grip){
  const geo = new THREE.ConeGeometry(0.01, 0.08, 16);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8888ff, metalness: 0, roughness: 0.9 });
  const cone = new THREE.Mesh(geo, mat);
  cone.rotation.x = Math.PI / 2;
  cone.position.z = -0.04;
  grip.add(cone);
}
function addLeftGunBlock(grip) {
  const geo = new THREE.BoxGeometry(0.10, 0.06, 0.16);
  const mat = new THREE.MeshStandardMaterial({ color: 0x4aa3ff, metalness: 0.0, roughness: 0.9 });
  const block = new THREE.Mesh(geo, mat);
  block.position.set(0, 0, 0);
  grip.add(block);
}
function buildControllerRay(controller){
  const geometry = new THREE.BufferGeometry().setFromPoints([ new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-1) ]);
  const material = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7 });
  const line = new THREE.Line(geometry, material);
  line.name = 'ray';
  line.scale.z = 1.5;
  controller.add(line);
}

let controllerModelFactory = null;
if (USE_SIMPLE_VIZ) {
  addSimpleControllerViz(controllerGrip0);
  addSimpleControllerViz(controllerGrip1);
} else {
  controllerModelFactory = new XRControllerModelFactory();
  controllerGrip0.add(controllerModelFactory.createControllerModel(controllerGrip0));
  controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
}
scene.add(controllerGrip0, controllerGrip1);

buildControllerRay(controller0);
buildControllerRay(controller1);

let leftController = null, rightController = null;
let leftGrip = null, rightGrip = null;

let menuPrev = false;
let squeezeTimer = 0;

function onConnected(event) {
  const src = event.data;
  this.userData.handedness = src.handedness;
  this.userData.gamepad = src.gamepad || null;

  if (src.handedness === 'left') {
    leftController = this;
    leftGrip = (this === controller0) ? controllerGrip0 : controllerGrip1;
    addLeftGunBlock(leftGrip);
  } else if (src.handedness === 'right') {
    rightController = this;
    rightGrip = (this === controller0) ? controllerGrip0 : controllerGrip1;
  }
}
controller0.addEventListener('connected', onConnected);
controller1.addEventListener('connected', onConnected);
controller0.addEventListener('disconnected', function(){ this.remove(this.children[0]); });
controller1.addEventListener('disconnected', function(){ this.remove(this.children[0]); });

controller0.addEventListener('selectstart', onSelectStart);
controller1.addEventListener('selectstart', onSelectStart);

function onSelectStart(evt) {
  if (!xrActive) return;
  const target = evt.target;

  if (tryPressUIButton(target)) return;

  if (!floorLocked && target === leftController && reticle.visible) {
    lockFloorAtReticle(); return;
  }
  if (target === rightController && lastHitPose) {
    addPlaneColliderAtHit(lastHitPose); return;
  }
  if (floorLocked && target === leftController) {
    fireFromLeft();
  }
}

// ==============================
// Bälle – shared Geo/Mat + Sleep
// ==============================
const balls = []; // { mesh, body, bornAt }
const BALL_GEO = new THREE.SphereGeometry(BALL_RADIUS, 16, 12);
const BALL_MAT = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.0 });

function syncMeshesFromPhysics() {
  for (let i = 0; i < balls.length; i++) {
    const { mesh, body } = balls[i];
    mesh.position.copy(body.position);
    mesh.quaternion.copy(body.quaternion);
  }
}

function spawnBall(origin, dir) {
  if (balls.length >= BALL_LIMIT) removeBall(balls[0]);

  const mesh = new THREE.Mesh(BALL_GEO, BALL_MAT);
  scene.add(mesh);

  const shape = new CANNON.Sphere(BALL_RADIUS);
  const body = new CANNON.Body({ mass: BALL_MASS, material: matBall });
  body.addShape(shape);

  body.position.set(origin.x, origin.y, origin.z);
  body.velocity.set(dir.x * BALL_SPEED, dir.y * BALL_SPEED, dir.z * BALL_SPEED);
  body.angularVelocity.set((Math.random()-0.5)*5, (Math.random()-0.5)*5, (Math.random()-0.5)*5);

  // Sleep
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.08;
  body.sleepTimeLimit  = 0.8;

  // kurze No-Collision-Phase
  body.collisionResponse = false;
  setTimeout(() => { body.collisionResponse = true; }, BALL_NO_COLLISION_MS);

  world.addBody(body);

  const item = { mesh, body, bornAt: performance.now() };
  balls.push(item);
  return item;
}

function removeBall(item) {
  scene.remove(item.mesh);
  world.removeBody(item.body);
  const i = balls.indexOf(item);
  if (i !== -1) balls.splice(i, 1);
}

function clearAllBalls() { while (balls.length) removeBall(balls[0]); }

function fireFromLeft() {
  if (!leftGrip) return;
  leftGrip.updateMatrixWorld(true);
  const origin = new THREE.Vector3().setFromMatrixPosition(leftGrip.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(
    new THREE.Quaternion().setFromRotationMatrix(leftGrip.matrixWorld)
  ).normalize();
  const spawnPos = origin.clone().addScaledVector(dir, BALL_SPAWN_OFFSET);
  spawnBall(spawnPos, dir);
}

// ==============================
// Boden setzen
// ==============================
function lockFloorAtReticle() {
  floorLocked = true;
  const y = reticle.position.y;
  groundBody.position.y = y;
  grid.position.y = y;

  reticle.visible = false;   // danach unsichtbar
  signMesh.visible = false;  // Schild aus

  setSignText("✅ Boden gesetzt.\nLinker Trigger: Bälle • Rechter Trigger: Fläche • Menü (links): UI-Panel");
  showHint(`✅ Boden gesetzt (y=${y.toFixed(2)} m).`);
}

// ==============================
// Manuelle Flächen (Box)
// ==============================
const colliders = [];
const DEFAULT_W = 1.0, DEFAULT_H = 1.0, THICK = 0.02;

function addPlaneColliderAtHit(pose) {
  const { position, orientation } = pose.transform;
  const q = orientation;

  const geo = new THREE.BoxGeometry(DEFAULT_W, THICK, DEFAULT_H);
  const mat = new THREE.MeshStandardMaterial({ color: 0x00ff88, transparent: true, opacity: 0.25 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(position.x, position.y, position.z);
  mesh.quaternion.set(q.x, q.y, q.z, q.w);
  scene.add(mesh);

  const half = new CANNON.Vec3(DEFAULT_W/2, THICK/2, DEFAULT_H/2);
  const body = new CANNON.Body({ mass: 0, material: matWorld });
  body.addShape(new CANNON.Box(half));
  body.position.set(position.x, position.y, position.z);
  body.quaternion.set(q.x, q.y, q.z, q.w);
  world.addBody(body);

  colliders.push({ mesh, body });
  showHint('➕ Fläche hinzugefügt.');
}

// ==============================
// Raum-Mesh → CANNON.Trimesh (performant + unsichtbar)
// ==============================
const meshMap = new Map(); // XRMesh -> { body, debugMesh?, lastChangedTime, radius }
let meshFrameCounter = 0;
const camPos = new THREE.Vector3();

function estimateRadius(vertices) {
  // einfache Bounding-Sphere-Schätzung um (0,0,0)
  let maxR2 = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i+1], z = vertices[i+2];
    const r2 = x*x + y*y + z*z;
    if (r2 > maxR2) maxR2 = r2;
  }
  return Math.sqrt(maxR2);
}

function semanticsAccepted(xrmesh) {
  if (!Array.isArray(ACCEPT_SEMANTICS) || ACCEPT_SEMANTICS.length === 0) return true;
  const lbl = (xrmesh.semanticLabel || '').toString().toLowerCase();
  if (!lbl) return true; // kein Label → nicht rausfiltern
  return ACCEPT_SEMANTICS.includes(lbl);
}

function handleDetectedMeshes(frame) {
  // Throttle
  meshFrameCounter = (meshFrameCounter + 1) % DETECTED_MESH_UPDATE_RATE;
  if (meshFrameCounter !== 0) return;

  const detected = frame.detectedMeshes;
  if (!detected) return;

  camera.getWorldPosition(camPos);

  let count = 0;
  const seen = new Set();

  for (const xrmesh of detected) {
    if (count >= MAX_MESHES) break;

    if (!semanticsAccepted(xrmesh)) continue;

    const pose = frame.getPose(xrmesh.meshSpace, refSpace);
    if (!pose) continue;

    const p = pose.transform.position;
    const q = pose.transform.orientation;

    const rec = meshMap.get(xrmesh);
    const changed = !rec || (xrmesh.lastChangedTime > (rec.lastChangedTime ?? -1));

    // Distanz-Culling mit Radius-Puffer
    const dist = Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z);
    const radius = rec?.radius ?? estimateRadius(xrmesh.vertices);
    if (dist - radius > MAX_MESH_DISTANCE) {
      if (rec) { removeMeshRecord(xrmesh, rec); meshMap.delete(xrmesh); }
      continue;
    }

    if (!rec) {
      const shape = createTrimeshShapeCapped(xrmesh.vertices, xrmesh.indices);
      if (!shape) continue;

      const body = new CANNON.Body({ mass: 0, material: matWorld });
      body.addShape(shape);
      body.position.set(p.x, p.y, p.z);
      body.quaternion.set(q.x, q.y, q.z, q.w);
      body.collisionResponse = meshCollisionsEnabled; // Schalter respektieren
      world.addBody(body);

      let debugMesh = null;
      if (ENABLE_MESH_DEBUG) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(xrmesh.vertices, 3));
        geom.setIndex(new THREE.BufferAttribute(xrmesh.indices, 1));
        const dmat = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.15 });
        debugMesh = new THREE.Mesh(geom, dmat);
        debugMesh.position.set(p.x, p.y, p.z);
        debugMesh.quaternion.set(q.x, q.y, q.z, q.w);
        scene.add(debugMesh);
      }

      meshMap.set(xrmesh, { body, debugMesh, lastChangedTime: xrmesh.lastChangedTime, radius });
    } else {
      // Pose-Update
      rec.body.position.set(p.x, p.y, p.z);
      rec.body.quaternion.set(q.x, q.y, q.z, q.w);
      if (rec.debugMesh) {
        rec.debugMesh.position.set(p.x, p.y, p.z);
        rec.debugMesh.quaternion.set(q.x, q.y, q.z, q.w);
      }

      if (changed) {
        world.removeBody(rec.body);
        const shape = createTrimeshShapeCapped(xrmesh.vertices, xrmesh.indices);
        if (shape) {
          const newBody = new CANNON.Body({ mass: 0, material: matWorld });
          newBody.addShape(shape);
          newBody.position.set(p.x, p.y, p.z);
          newBody.quaternion.set(q.x, q.y, q.z, q.w);
          newBody.collisionResponse = meshCollisionsEnabled;
          world.addBody(newBody);
          rec.body = newBody;

          // Radius ggf. neu schätzen
          rec.radius = estimateRadius(xrmesh.vertices);

          if (rec.debugMesh) {
            scene.remove(rec.debugMesh);
            rec.debugMesh.geometry.dispose();
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(xrmesh.vertices, 3));
            geom.setIndex(new THREE.BufferAttribute(xrmesh.indices, 1));
            rec.debugMesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.15 }));
            rec.debugMesh.position.set(p.x, p.y, p.z);
            rec.debugMesh.quaternion.set(q.x, q.y, q.z, q.w);
            scene.add(rec.debugMesh);
          }
        }
        rec.lastChangedTime = xrmesh.lastChangedTime;
      }
    }

    seen.add(xrmesh);
    count++;
  }

  // Entfernen nicht gesehener Meshes
  for (const [meshKey, rec] of meshMap) {
    if (!seen.has(meshKey)) {
      removeMeshRecord(meshKey, rec);
      meshMap.delete(meshKey);
    }
  }
}

function createTrimeshShapeCapped(verticesTyped, indicesTyped) {
  if (!verticesTyped || !indicesTyped) return null;
  const triCount = (indicesTyped.length / 3) | 0;
  if (triCount === 0) return null;

  // Downsample per stride
  let indices;
  if (triCount > MAX_TRIANGLES_PER_MESH) {
    const stride = Math.ceil(triCount / MAX_TRIANGLES_PER_MESH);
    const tmp = [];
    for (let t = 0; t < triCount; t += stride) {
      const i3 = t * 3;
      tmp.push(indicesTyped[i3], indicesTyped[i3+1], indicesTyped[i3+2]);
    }
    indices = new Uint32Array(tmp);
  } else {
    indices = indicesTyped;
  }

  try { return new CANNON.Trimesh(verticesTyped, indices); }
  catch (e) { console.warn('Trimesh-Erstellung fehlgeschlagen:', e); return null; }
}

function removeMeshRecord(meshKey, rec) {
  world.removeBody(rec.body);
  if (rec.debugMesh) {
    scene.remove(rec.debugMesh);
    rec.debugMesh.geometry.dispose();
    rec.debugMesh.material.dispose();
  }
}

// ==============================
// UI-Interaktion (Buttons)
// ==============================
function tryPressUIButton(controller) {
  if (!xrActive || !uiRoot.visible) return false;

  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, -1);
  controller.updateMatrixWorld(true);
  origin.setFromMatrixPosition(controller.matrixWorld);
  dir.applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(controller.matrixWorld)).normalize();

  raycaster.set(origin, dir);
  raycaster.far = 3.0;
  const hits = raycaster.intersectObjects(interactive, false);
  if (hits.length === 0) return false;

  const obj = hits[0].object;
  if (obj === clearBtnFront) {
    clearAllBalls();
    setSignText("🧹 Alle Bälle gelöscht.\nMenü (links): UI ein/aus • 🧱 Mesh-Kollisionen umschalten");
    flashButton(clearBtnRoot);
    return true;
  }
  if (obj === meshBtnFront) {
    toggleMeshCollisions();
    flashButton(meshBtnRoot);
    return true;
  }
  return false;
}

function updateUIBillboard() {
  if (!xrActive) return;

  const dist = 0.7;
  const offsetSign = new THREE.Vector3(-0.08, -0.12, -dist);
  const offsetPanel = new THREE.Vector3(0.02, -0.12, -dist);

  if (signMesh.visible) {
    signMesh.position.copy(camera.localToWorld(offsetSign.clone()));
    signMesh.quaternion.copy(camera.quaternion);
  }

  if (uiRoot.visible) {
    uiRoot.position.copy(camera.localToWorld(offsetPanel.clone()));
    uiRoot.quaternion.copy(camera.quaternion);
  }
}

function updateUIHoverThrottled(controller) {
  const now = performance.now();
  if (now - lastRayTs < RAYCAST_INTERVAL_MS) return;
  lastRayTs = now;

  if (!uiRoot.visible) return;

  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, -1);
  controller.updateMatrixWorld(true);
  origin.setFromMatrixPosition(controller.matrixWorld);
  dir.applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(controller.matrixWorld)).normalize();

  raycaster.set(origin, dir);
  raycaster.far = 3.0;
  const hits = raycaster.intersectObjects(interactive, false);
  const nowHover = (hits.length > 0) ? hits[0].object : null;

  if (hovered !== nowHover) {
    hovered = nowHover;
    setClearBtnState(hovered === clearBtnFront ? 'hover' : 'idle');
    setToggleVisual(hovered === meshBtnFront ? 'hover' : 'idle', meshCollisionsEnabled);
  }
}

// ==============================
// Session Events
// ==============================
renderer.xr.addEventListener('sessionstart', async () => {
  xrActive = true;

  signMesh.visible = true;
  uiRoot.visible = false;

  xrSession = renderer.xr.getSession();
  refSpace = renderer.xr.getReferenceSpace();
  try {
    viewerSpace = await xrSession.requestReferenceSpace('viewer');
    if (xrSession.requestHitTestSource) {
      hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
      setSignText("👀 Schaue auf den Boden und platziere das Reticle.\nDrücke den TRIGGER der LINKEN Hand, um die Bodenhöhe zu setzen.");
    } else {
      setSignText("ℹ️ Hit-Test nicht verfügbar – Boden bleibt bei y=0.\nMenü (links): UI ein/aus • 🧹 Bälle löschen • 🧱 Mesh-Kollisionen");
    }
  } catch (e) {
    console.warn('Hit-Test Setup fehlgeschlagen:', e);
    setSignText("ℹ️ Hit-Test nicht verfügbar – Boden bleibt bei y=0.\nMenü (links): UI ein/aus • 🧹 Bälle löschen • 🧱 Mesh-Kollisionen");
  }
});

renderer.xr.addEventListener('sessionend', () => {
  xrActive = false;
  signMesh.visible = false;
  uiRoot.visible = false;
  reticle.visible = false;

  xrSession = null; viewerSpace = null; refSpace = null; hitTestSource = null;

  for (const [meshKey, rec] of meshMap) removeMeshRecord(meshKey, rec);
  meshMap.clear();

  showHint('ℹ️ AR-Session beendet');
});

// ==============================
// Loop
// ==============================
renderer.setAnimationLoop((_, frame) => {
  // Physik
  world.step(FIXED_DT);

  // Bälle-Despawn
  const now = performance.now();
  for (let i = balls.length - 1; i >= 0; i--) {
    if (now - balls[i].bornAt > BALL_LIFETIME) removeBall(balls[i]);
  }

  // XR Hit-Test
  if (xrActive && frame && hitTestSource && refSpace) {
    const results = frame.getHitTestResults(hitTestSource);
    if (results && results.length > 0) {
      const pose = results[0].getPose(refSpace);
      if (pose) {
        lastHitPose = pose;
        reticle.visible = !floorLocked;
        if (!floorLocked) {
          reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
        }
      }
    } else {
      lastHitPose = null;
      reticle.visible = false;
    }
  }

  // Raum-Meshes (performant)
  if (xrActive && frame && typeof frame.detectedMeshes !== 'undefined' && refSpace) {
    handleDetectedMeshes(frame);
  }

  // Three <-> Physik sync (nur Bälle)
  syncMeshesFromPhysics();

  // UI
  if (xrActive) {
    updateUIBillboard();
    if (uiRoot.visible) {
      updateUIHoverThrottled(controller0);
      updateUIHoverThrottled(controller1);
    }
    pollMenuToggle();
  }

  renderer.render(scene, camera);
});

// ==============================
// Menütaste / Fallback → UI-Panel togglen
// ==============================
function pollMenuToggle() {
  const left = leftController;
  if (!left) return;
  const gp = left.userData.gamepad;
  let pressed = false;

  if (gp && gp.buttons && gp.buttons.length) {
    const candidates = [4,3,2]; // X/Menu/Y/Stick (robust)
    for (const idx of candidates) {
      if (gp.buttons[idx] && gp.buttons[idx].pressed) { pressed = true; break; }
    }
  }
  if (pressed && !menuPrev) uiRoot.visible = !uiRoot.visible;
  menuPrev = pressed;

  // Fallback: Longpress auf Left-SQUEEZE (>=1s)
  if (gp && gp.buttons && gp.buttons[1]) {
    if (gp.buttons[1].pressed) {
      squeezeTimer += FIXED_DT;
      if (squeezeTimer >= 1.0) { uiRoot.visible = !uiRoot.visible; squeezeTimer = 0; }
    } else squeezeTimer = 0;
  }
}

// ==============================
// UI-Helfer (Hint unten links)
// ==============================
function showHint(text) {
  let el = document.getElementById('hint');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hint';
    el.style.position = 'fixed';
    el.style.left = '12px';
    el.style.bottom = '12px';
    el.style.zIndex = '9999';
    el.style.padding = '8px 10px';
    el.style.fontFamily = 'system-ui, sans-serif';
    el.style.fontSize = '12px';
    el.style.background = 'rgba(0,0,0,0.6)';
    el.style.color = '#eee';
    el.style.borderRadius = '8px';
    el.style.maxWidth = '80vw';
    document.body.appendChild(el);
  }
  el.textContent = text;
}

// ==============================
// UI-Bausteine (Schild + Buttons)
// ==============================
function createBillboardSign(initialText) {
  const w = 1024, h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  function draw(text) {
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = 'rgba(20,20,20,0.75)';
    roundRect(ctx, 20, 20, w-40, h-40, 28, true, false);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 4;
    roundRect(ctx, 20, 20, w-40, h-40, 28, false, true);

    ctx.fillStyle = '#e8f6ff';
    ctx.font = 'bold 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const lines = text.split('\n');
    let y = 120;
    for (const line of lines) {
      wrapAndDraw(ctx, line, 60, y, w-120, 44);
      y += 70;
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
  const geo = new THREE.PlaneGeometry(0.48, 0.24);
  const mesh = new THREE.Mesh(geo, mat);

  function setText(t) { draw(t); texture.needsUpdate = true; }
  draw(initialText);

  return { signMesh: mesh, setSignText: setText };
}

function wrapAndDraw(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      ctx.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, y);
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function createClearBallsButton() {
  const root = new THREE.Group();

  const bodyGeo = new THREE.BoxGeometry(0.16, 0.06, 0.02);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0, roughness: 1, transparent: true, opacity: 0.85 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  root.add(body);

  const w = 512, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  function drawFront(state='idle') {
    ctx.clearRect(0,0,w,h);
    const bg = (state === 'hover') ? '#35f3a6' : '#00d08a';
    ctx.fillStyle = bg; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#10261e';
    ctx.font = 'bold 48px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const label = '🧹  Alle Bälle löschen';
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, (w - tw)/2, h/2 + 18);
  }
  drawFront('idle');

  const tex = new THREE.CanvasTexture(canvas);
  const frontMat = new THREE.MeshBasicMaterial({ map: tex });
  const frontGeo = new THREE.PlaneGeometry(0.145, 0.045);
  const front = new THREE.Mesh(frontGeo, frontMat);
  front.position.z = 0.011;
  root.add(front);

  function setState(state) { drawFront(state); tex.needsUpdate = true; }

  return { buttonRoot: root, buttonFront: front, setButtonState: setState };
}

function createMeshToggleButton() {
  const root = new THREE.Group();

  const bodyGeo = new THREE.BoxGeometry(0.16, 0.06, 0.02);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0, roughness: 1, transparent: true, opacity: 0.85 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  root.add(body);

  const w = 512, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  function drawFront(state='idle', enabled=true) {
    ctx.clearRect(0,0,w,h);
    const bgOn  = (state === 'hover') ? '#8af' : '#69f';
    const bgOff = (state === 'hover') ? '#f88' : '#f55';
    ctx.fillStyle = enabled ? bgOn : bgOff;
    ctx.fillRect(0,0,w,h);
    ctx.fillStyle = enabled ? '#0b1333' : '#3a0b0b';
    ctx.font = 'bold 44px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const label = enabled ? '🧱  Mesh-Kollisionen: AN' : '🧱  Mesh-Kollisionen: AUS';
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, (w - tw)/2, h/2 + 16);
  }
  drawFront('idle', meshCollisionsEnabled);

  const tex = new THREE.CanvasTexture(canvas);
  const frontMat = new THREE.MeshBasicMaterial({ map: tex });
  const frontGeo = new THREE.PlaneGeometry(0.145, 0.045);
  const front = new THREE.Mesh(frontGeo, frontMat);
  front.position.z = 0.011;
  root.add(front);

  function setVisual(state, enabled) { drawFront(state, enabled); tex.needsUpdate = true; }

  return { toggleRoot: root, toggleFront: front, setToggleVisual: setVisual };
}

function flashButton(root) {
  const start = performance.now();
  const dur = 120;
  const base = root.position.z;
  function tick() {
    const t = performance.now() - start;
    const k = Math.min(1, t / dur);
    root.position.z = base - 0.01 * Math.sin(k * Math.PI);
    if (k < 1) requestAnimationFrame(tick);
    else root.position.z = base;
  }
  tick();
}

function toggleMeshCollisions() {
  meshCollisionsEnabled = !meshCollisionsEnabled;
  for (const [, rec] of meshMap) rec.body.collisionResponse = meshCollisionsEnabled;
  setToggleVisual('idle', meshCollisionsEnabled);
  showHint(meshCollisionsEnabled ? '🧱 Mesh-Kollisionen: AN' : '🧱 Mesh-Kollisionen: AUS');
}
