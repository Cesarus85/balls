// --- Imports (fixierte Versionen) ---
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.168.0/build/three.module.js';
import { ARButton } from 'https://cdn.jsdelivr.net/npm/three@0.168.0/examples/jsm/webxr/ARButton.js';
import { XRControllerModelFactory } from 'https://cdn.jsdelivr.net/npm/three@0.168.0/examples/jsm/webxr/XRControllerModelFactory.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// --- Renderer/Scene/Camera ---
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;

// WICHTIG für Passthrough (Hintergrund durchsichtig):
renderer.setClearAlpha(0); // oder:
// renderer.setClearColor(0x000000, 0);

document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

// Licht
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(1, 2, 1);
scene.add(dir);

// Dezentes Grid (y=0) – nur Debug/Orientierung
const grid = new THREE.GridHelper(4, 8, 0x888888, 0x444444);
grid.position.y = 0;
grid.material.opacity = 0.25;
grid.material.transparent = true;
scene.add(grid);

// --- AR Button (ohne requiredFeatures) ---
const sessionInit = {
  // NUR optional → maximal kompatibel
  optionalFeatures: [
    'local-floor', 'bounded-floor',
    'hit-test', 'anchors',
    'dom-overlay', 'hand-tracking'
  ],
  // dom-overlay erlaubt HTML-Overlays in AR (optional)
  domOverlay: { root: document.body }
};

// Fallback-Hinweise, falls kein XR vorhanden (z. B. Desktop/kein HTTPS)
if (!('xr' in navigator)) {
  console.warn('WebXR nicht verfügbar. Öffne die Seite auf einer Meta Quest im Browser und nutze HTTPS.');
  showHint('⚠️ WebXR nicht verfügbar. Bitte auf der Quest im Meta-Browser per HTTPS öffnen.');
}

// Button anhängen
const arBtn = ARButton.createButton(renderer, sessionInit);
document.body.appendChild(arBtn);

// Debug: Session-Events
renderer.xr.addEventListener('sessionstart', () => showHint('✅ AR-Session gestartet (Passthrough aktiv)'));
renderer.xr.addEventListener('sessionend',   () => showHint('ℹ️ AR-Session beendet'));

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

// Boden-Plane (y=0)
const groundBody = new CANNON.Body({ mass: 0, material: matWorld });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

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

function onSelectStart(evt) {
  if (!leftController) return;
  if (evt.target !== leftController) return;
  fireFromLeft();
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

// --- Resize ---
window.addEventListener('resize', onWindowResize, false);
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Loop ---
const fixedTimeStep = 1 / 60;
renderer.setAnimationLoop(() => {
  world.step(fixedTimeStep);

  const now = performance.now();
  for (let i = balls.length - 1; i >= 0; i--) {
    if (now - balls[i].bornAt > BALL_LIFETIME) removeBall(balls[i]);
  }

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
    document.body.appendChild(el);
  }
  el.textContent = text;
}
