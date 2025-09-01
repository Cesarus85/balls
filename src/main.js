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
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

// Licht
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(1, 2, 1);
scene.add(dir);

// Optional: dezentes Grid zur Orientierung (y=0)
const grid = new THREE.GridHelper(4, 8, 0x888888, 0x444444);
grid.position.y = 0;
grid.material.opacity = 0.25;
grid.material.transparent = true;
scene.add(grid);

// --- AR Button ---
const sessionInit = {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['hit-test', 'hand-tracking', 'anchors']
};
document.body.appendChild(ARButton.createButton(renderer, sessionInit));

// --- Physik-Welt ---
const world = new CANNON.World({
  gravity: new CANNON.Vec3(0, -9.82, 0)
});

// Materialien & Kontakte
const matBall = new CANNON.Material('ball');
const matWorld = new CANNON.Material('world');
world.defaultContactMaterial.contactEquationStiffness = 1e7;
world.defaultContactMaterial.contactEquationRelaxation = 3;

const contact = new CANNON.ContactMaterial(matBall, matWorld, {
  friction: 0.35,      // Roll-/Gleitreibung
  restitution: 0.6     // Bounciness
});
world.addContactMaterial(contact);

// Boden-Plane (y=0)
const groundBody = new CANNON.Body({ mass: 0, material: matWorld });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // normal nach +Y
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

// Linke/rechte Hand erkennen
function onConnected(event) {
  const src = event.data;
  this.userData.handedness = src.handedness;
  if (src.handedness === 'left') {
    leftController = this;
    leftGrip = (this === controller0) ? controllerGrip0 : controllerGrip1;
    // "Waffen"-Block am linken Grip anbringen
    addLeftGunBlock(leftGrip);
  }
}
controller0.addEventListener('connected', onConnected);
controller1.addEventListener('connected', onConnected);

controller0.addEventListener('disconnected', function () { this.remove(this.children[0]); });
controller1.addEventListener('disconnected', function () { this.remove(this.children[0]); });

// Schießen (Trigger) nur auf der linken Hand
function onSelectStart(evt) {
  if (!leftController) return;
  if (evt.target !== leftController) return;
  fireFromLeft();
}
controller0.addEventListener('selectstart', onSelectStart);
controller1.addEventListener('selectstart', onSelectStart);

// --- Waffenblock (links) ---
function addLeftGunBlock(grip) {
  // Optik: einfacher Block
  const geo = new THREE.BoxGeometry(0.10, 0.06, 0.16);
  const mat = new THREE.MeshStandardMaterial({ color: 0x4aa3ff, metalness: 0.0, roughness: 0.9 });
  const block = new THREE.Mesh(geo, mat);
  block.castShadow = false;
  block.receiveShadow = false;
  block.position.set(0, 0, 0); // sitzt direkt am Grip
  grip.add(block);
}

// --- Ball-Objekte & Sync ---
const balls = []; // { mesh, body, bornAt }

const BALL_RADIUS = 0.02;       // 2 cm Radius ~ 40 mm Ø
const BALL_MASS = 0.003;        // ~2.7–3 g
const BALL_SPEED = 3.5;         // Startgeschwindigkeit (m/s)
const BALL_LIMIT = 200;         // Sicherheitslimit
const BALL_LIFETIME = 20 * 1000;// 20 s (ms)

// Drehsync: Physik -> Three
function syncMeshesFromPhysics() {
  for (let i = 0; i < balls.length; i++) {
    const { mesh, body } = balls[i];
    mesh.position.copy(body.position);
    mesh.quaternion.copy(body.quaternion);
  }
}

// Ball spawnen
function spawnBall(origin, dir) {
  if (balls.length >= BALL_LIMIT) {
    // Ältesten Ball entfernen (Ringpuffer)
    removeBall(balls[0]);
  }

  // THREE-Mesh
  const sphereGeo = new THREE.SphereGeometry(BALL_RADIUS, 16, 12);
  const sphereMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.0 });
  const mesh = new THREE.Mesh(sphereGeo, sphereMat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);

  // CANNON-Body
  const shape = new CANNON.Sphere(BALL_RADIUS);
  const body = new CANNON.Body({ mass: BALL_MASS, material: matBall });
  body.addShape(shape);
  body.position.set(origin.x, origin.y, origin.z);

  // Anfangsgeschwindigkeit
  const v = new CANNON.Vec3(dir.x * BALL_SPEED, dir.y * BALL_SPEED, dir.z * BALL_SPEED);
  body.velocity.copy(v);

  // Leicht rotieren lassen (optisch)
  body.angularVelocity.set((Math.random()-0.5)*5, (Math.random()-0.5)*5, (Math.random()-0.5)*5);

  world.addBody(body);

  const item = { mesh, body, bornAt: performance.now() };
  balls.push(item);
  return item;
}

// Ball entfernen
function removeBall(item) {
  scene.remove(item.mesh);
  item.mesh.geometry.dispose();
  item.mesh.material.dispose();
  world.removeBody(item.body);
  const idx = balls.indexOf(item);
  if (idx !== -1) balls.splice(idx, 1);
}

// Aus der linken Hand feuern
function fireFromLeft() {
  if (!leftGrip) return;

  // Ursprung & Richtung aus Controller-Transform
  leftGrip.updateMatrixWorld(true);

  const origin = new THREE.Vector3();
  origin.setFromMatrixPosition(leftGrip.matrixWorld);

  // Richtung = -Z des Grips in Weltkoordinaten
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(leftGrip.matrixWorld)).normalize();

  // Ball wenige cm vor dem Block erscheinen lassen
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
  // Physik
  world.step(fixedTimeStep);

  // Despawn-Check
  const now = performance.now();
  for (let i = balls.length - 1; i >= 0; i--) {
    if (now - balls[i].bornAt > BALL_LIFETIME) {
      removeBall(balls[i]);
    }
  }

  // Sync
  syncMeshesFromPhysics();

  renderer.render(scene, camera);
});
