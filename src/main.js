// --- Imports über Import-Map (siehe index.html) ---
import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// --- Renderer/Scene/Camera ---
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;

// Passthrough sichtbar machen (transparentes WebGL-Canvas):
renderer.setClearAlpha(0);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

// Licht
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(1, 2, 1);
scene.add(dir);

// Debug-Grid (wird automatisch auf die erkannte Bodenhöhe verschoben)
const grid = new THREE.GridHelper(4, 8, 0x888888, 0x444444);
grid.material.opacity = 0.25;
grid.material.transparent = true;
scene.add(grid);

// --- AR Button / Session-Setup ---
const sessionInit = {
  // Nur optionale Features, damit der Button nicht verschwindet, wenn etwas fehlt
  optionalFeatures: [
    'local-floor', 'bounded-floor',
    'hit-test', 'anchors',
    'dom-overlay', 'hand-tracking'
  ],
  domOverlay: { root: document.body }
};

if (!('xr' in navigator)) {
  showHint('⚠️ WebXR nicht verfügbar. Bitte auf der Quest im Meta-Browser per HTTPS öffnen.');
}
const arBtn = ARButton.createButton(renderer, sessionInit);
document.body.appendChild(arBtn);

// XR-Session / Hit-Test Variablen
let xrSession = null;
let viewerSpace = null;
let refSpace = null;
let hitTestSource = null;

renderer.xr.addEventListener('sessionstart', async () => {
  xrSession = renderer.xr.getSession();
  refSpace = renderer.xr.getReferenceSpace();
  try {
    viewerSpace = await xrSession.requestReferenceSpace('viewer');
    if (xrSession.requestHitTestSource) {
      hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
      showHint('👀 Bewege den Blick/Controller – Reticle zeigt Boden. Drücke Trigger zum Setzen.');
    } else {
      showHint('ℹ️ Hit-Test nicht verfügbar – Boden bleibt bei y=0.');
    }
  } catch (e) {
    console.warn('Hit-Test Setup fehlgeschlagen:', e);
    showHint('ℹ️ Hit-Test nicht verfügbar – Boden bleibt bei y=0.');
  }
});

renderer.xr.addEventListener('sessionend', () => {
  xrSession = null;
  viewerSpace = null;
  refSpace = null;
  hitTestSource = null;
  reticle.visible = false;
  showHint('ℹ️ AR-Session beendet');
});

// --- Physik-Welt ---
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
const matBall  = new CANNON.Material('ball');
const matWorld = new CANNON.Material('world');
world.defaultContactMaterial.contactEquationStiffness = 1e7;
world.defaultContactMaterial.contactEquationRelaxation = 3;
world.addContactMaterial(new CANNON.ContactMaterial(matBall, matWorld, {
  friction: 0.35,
  restitution: 0.6
}));

// Boden-Plane (zunächst y=0, später via Hit-Test gesetzt)
const groundBody = new CANNON.Body({ mass: 0, material: matWorld });
groundBody.addShape(new CANNON.Plane());
// In Cannon zeigt die Standard-Plane normal nach +Z → -90° um X, damit normal nach +Y (Boden)
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
groundBody.position.set(0, 0, 0);
world.addBody(groundBody);

// Grid initial ausrichten
grid.position.y = groundBody.position.y;

// --- Reticle für Hit-Test ---
const reticleGeo = new THREE.RingGeometry(0.06, 0.08, 32);
reticleGeo.rotateX(-Math.PI / 2);
const reticleMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 });
const reticle = new THREE.Mesh(reticleGeo, reticleMat);
reticle.visible = false;
scene.add(reticle);

let floorLocked = false;

// --- Controller Setup ---
const controller0 = renderer.xr.getController(0);
const controller1 = renderer.xr.getController(1);
scene.add(controller0, controller1);

const controllerModelFactory = new XRControllerModelFactory();
const controllerGrip0 = renderer.xr.getControllerGrip(0);
const controllerGrip1 = renderer.xr.getControllerGrip(1);
controllerGrip0.add(controllerModelFactory.createControllerModel(controllerGrip0));
controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
scene.add(controllerGrip0, controllerGrip1);

let leftController = null;
let leftGrip = null;

function onConnected(event) {
  const src = event.data;
  this.userData.handedness = src.handedness;
  if (src.handedness === 'left') {
    leftController = this;
    leftGrip = (this === controller0) ? controllerGrip0 : controllerGrip1;
    addLeftGunBlock(leftGrip);
  }
}
controller0.addEventListener('connected', onConnected);
controller1.addEventListener('connected', onConnected);
controller0.addEventListener('disconnected', function () { this.remove(this.children[0]); });
controller1.addEventListener('disconnected', function () { this.remove(this.children[0]); });

// Beim ersten Trigger: Boden setzen (falls Reticle sichtbar). Danach: linke Hand feuert.
function onSelectStart(evt) {
  // 1) Boden setzen?
  if (!floorLocked && reticle.visible) {
    lockFloorAtReticle();
    return;
  }
  // 2) Sonst: nur wenn linke Hand triggert → feuern
  if (leftController && evt.target === leftController) {
    fireFromLeft();
  }
}
controller0.addEventListener('selectstart', onSelectStart);
controller1.addEventListener('selectstart', onSelectStart);

// --- Waffenblock (links) ---
function addLeftGunBlock(grip) {
  const geo = new THREE.BoxGeometry(0.10, 0.06, 0.16);
  const mat = new THREE.MeshStandardMaterial({ color: 0x4aa3ff, metalness: 0.0, roughness: 0.9 });
  const block = new THREE.Mesh(geo, mat);
  block.position.set(0, 0, 0);
  grip.add(block);
}

// --- Ball-Objekte & Sync ---
const balls = []; // { mesh, body, bornAt }
const BALL_RADIUS   = 0.02;         // 2 cm Radius ~ 40 mm Ø
const BALL_MASS     = 0.003;        // ~3 g
const BALL_SPEED    = 3.5;          // m/s
const BALL_LIMIT    = 200;
const BALL_LIFETIME = 20 * 1000;    // 20s

function syncMeshesFromPhysics() {
  for (let i = 0; i < balls.length; i++) {
    const { mesh, body } = balls[i];
    mesh.position.copy(body.position);
    mesh.quaternion.copy(body.quaternion);
  }
}

function spawnBall(origin, dir) {
  if (balls.length >= BALL_LIMIT) removeBall(balls[0]);

  const sphereGeo = new THREE.SphereGeometry(BALL_RADIUS, 16, 12);
  const sphereMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.0 });
  const mesh = new THREE.Mesh(sphereGeo, sphereMat);
  scene.add(mesh);

  const shape = new CANNON.Sphere(BALL_RADIUS);
  const body = new CANNON.Body({ mass: BALL_MASS, material: matBall });
  body.addShape(shape);
  body.position.set(origin.x, origin.y, origin.z);
  body.velocity.set(dir.x * BALL_SPEED, dir.y * BALL_SPEED, dir.z * BALL_SPEED);
  body.angularVelocity.set((Math.random()-0.5)*5, (Math.random()-0.5)*5, (Math.random()-0.5)*5);
  world.addBody(body);

  const item = { mesh, body, bornAt: performance.now() };
  balls.push(item);
  return item;
}

function removeBall(item) {
  scene.remove(item.mesh);
  item.mesh.geometry.dispose();
  item.mesh.material.dispose();
  world.removeBody(item.body);
  const i = balls.indexOf(item);
  if (i !== -1) balls.splice(i, 1);
}

function fireFromLeft() {
  if (!leftGrip) return;
  leftGrip.updateMatrixWorld(true);

  const origin = new THREE.Vector3().setFromMatrixPosition(leftGrip.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(
    new THREE.Quaternion().setFromRotationMatrix(leftGrip.matrixWorld)
  ).normalize();

  const spawnPos = origin.clone().addScaledVector(dir, 0.12);
  spawnBall(spawnPos, dir);
}

// --- Boden per Reticle setzen ---
function lockFloorAtReticle() {
  floorLocked = true;

  // Bodenhöhe übernehmen (wir halten die Plane horizontal; Neigung kommt in M6/M7)
  const y = reticle.position.y;
  groundBody.position.y = y;
  grid.position.y = y;

  // Reticle ausblenden, Hinweis zeigen
  reticle.visible = false;
  showHint(`✅ Boden gesetzt (y=${y.toFixed(2)} m). Linken Trigger drücken, um Bälle zu feuern.`);
}

// --- Resize ---
window.addEventListener('resize', onWindowResize, false);
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Render/Physics Loop mit Hit-Test ---
const fixedTimeStep = 1 / 60;

renderer.setAnimationLoop((_, frame) => {
  // Physik
  world.step(fixedTimeStep);

  // Lebenszeit-Despawn
  const now = performance.now();
  for (let i = balls.length - 1; i >= 0; i--) {
    if (now - balls[i].bornAt > BALL_LIFETIME) removeBall(balls[i]);
  }

  // XR Hit-Test aktualisieren (solange Boden noch nicht gesetzt)
  if (frame && hitTestSource && !floorLocked && refSpace) {
    const results = frame.getHitTestResults(hitTestSource);
    if (results && results.length > 0) {
      const pose = results[0].getPose(refSpace);
      if (pose) {
        reticle.visible = true;
        reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);

        // Reticle zeigt „flach“ auf die Fläche; für M5 reicht die Position (Höhe).
        // In M6/M7 orientieren wir Colliders passend zur Flächennormalen.
      }
    } else {
      reticle.visible = false;
    }
  }

  // Mesh-Transforms aus Physik übernehmen
  syncMeshesFromPhysics();

  renderer.render(scene, camera);
});

// --- Mini-Helfer ---
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
