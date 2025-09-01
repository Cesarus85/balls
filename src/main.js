// --- Imports via Import-Map (siehe index.html) ---
import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
// Wenn GLTF-Warnungen nerven: setze USE_SIMPLE_VIZ = true und kommentiere die nächste Zeile aus.
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';

// ==============================
// Konfiguration
// ==============================
const USE_SIMPLE_VIZ = false;           // einfache Controller-Viz statt GLTF
const ENABLE_MESH_DEBUG = false;        // zeigt Raum-Mesh als Wireframe (nur Debug)
const MAX_MESHES = 40;
const MAX_TRIANGLES_PER_MESH = 3000;
const ACCEPT_SEMANTICS = null;          // z.B. ['floor','wall'] oder null für alle

// ==============================
// Renderer / Scene / Camera
// ==============================
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.setClearAlpha(0); // Passthrough sichtbar
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);

// Licht
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(1, 2, 1);
scene.add(dir);

// Debug-Grid (wird auf Bodenhöhe verschoben)
const grid = new THREE.GridHelper(4, 8, 0x888888, 0x444444);
grid.material.opacity = 0.25;
grid.material.transparent = true;
scene.add(grid);

// ==============================
// AR-Button / Session
// ==============================
const sessionInit = {
  optionalFeatures: [
    'local-floor','bounded-floor',
    'hit-test','anchors','dom-overlay','hand-tracking',
    // Raum-Mesh
    'mesh-detection'
  ],
  domOverlay: { root: document.body }
};

if (!('xr' in navigator)) showHint('⚠️ WebXR nicht verfügbar. Bitte auf einer Quest im Meta-Browser per HTTPS öffnen.');
const arBtn = ARButton.createButton(renderer, sessionInit);
document.body.appendChild(arBtn);

// XR-Variablen
let xrSession = null, viewerSpace = null, refSpace = null, hitTestSource = null;

renderer.xr.addEventListener('sessionstart', async () => {
  xrSession = renderer.xr.getSession();
  refSpace = renderer.xr.getReferenceSpace();
  try {
    viewerSpace = await xrSession.requestReferenceSpace('viewer');
    if (xrSession.requestHitTestSource) {
      hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
      setSignText("👀 Schaue auf den Boden und platziere das Reticle.\nDrücke den TRIGGER der LINKEN Hand, um die Bodenhöhe zu setzen.");
    } else {
      setSignText("ℹ️ Hit-Test nicht verfügbar – Boden bleibt bei y=0.\nLinker Trigger: Bälle feuern • Rechter Trigger: Fläche platzieren • 🧹: Alle Bälle löschen");
    }
  } catch (e) {
    console.warn('Hit-Test Setup fehlgeschlagen:', e);
    setSignText("ℹ️ Hit-Test nicht verfügbar – Boden bleibt bei y=0.\nLinker Trigger: Bälle feuern • Rechter Trigger: Fläche platzieren • 🧹: Alle Bälle löschen");
  }
});

renderer.xr.addEventListener('sessionend', () => {
  xrSession = null; viewerSpace = null; refSpace = null; hitTestSource = null;
  reticle.visible = false;
  // Meshes aufräumen
  for (const [meshKey, rec] of meshMap) removeMeshRecord(meshKey, rec);
  meshMap.clear();
  showHint('ℹ️ AR-Session beendet');
});

// ==============================
// Physik (CANNON)
// ==============================
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
const matBall  = new CANNON.Material('ball');
const matWorld = new CANNON.Material('world');
world.defaultContactMaterial.contactEquationStiffness = 1e7;
world.defaultContactMaterial.contactEquationRelaxation = 3;
world.addContactMaterial(new CANNON.ContactMaterial(matBall, matWorld, { friction: 0.35, restitution: 0.6 }));

// Boden-Plane (zunächst y=0; später via Reticle gesetzt)
const groundBody = new CANNON.Body({ mass: 0, material: matWorld });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // normal +Y
groundBody.position.set(0, 0, 0);
world.addBody(groundBody);
grid.position.y = 0;

// ==============================
// Reticle (Hit-Test)
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
// Controller / Eingaben + Raycast
// ==============================
const controller0 = renderer.xr.getController(0);
const controller1 = renderer.xr.getController(1);
scene.add(controller0, controller1);

const controllerGrip0 = renderer.xr.getControllerGrip(0);
const controllerGrip1 = renderer.xr.getControllerGrip(1);
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

// Sichtbare Ray-Linien an den Controllern
buildControllerRay(controller0);
buildControllerRay(controller1);

let leftController = null, rightController = null;
let leftGrip = null, rightGrip = null;

function onConnected(event) {
  const src = event.data;
  this.userData.handedness = src.handedness;
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

// Trigger-Handling:
// 1) Boden setzen NUR mit linkem Trigger (solange Reticle sichtbar)
// 2) rechter Trigger: Fläche platzieren (Box)
// 3) linker Trigger (nach Floor-Lock): Bälle schießen
// 4) auf Button zielen + Trigger: Bälle löschen
controller0.addEventListener('selectstart', onSelectStart);
controller1.addEventListener('selectstart', onSelectStart);

function onSelectStart(evt) {
  const target = evt.target;

  // Button-Klick testen (Raycast)
  if (tryPressUIButton(target)) return;

  // Boden setzen?
  if (!floorLocked && target === leftController && reticle.visible) {
    lockFloorAtReticle();
    return;
  }
  // Fläche platzieren?
  if (target === rightController && reticle.visible && lastHitPose) {
    addPlaneColliderAtHit(lastHitPose);
    return;
  }
  // Schießen (nach Floor-Lock)
  if (floorLocked && target === leftController) {
    fireFromLeft();
  }
}

// ==============================
// Einfache Controller-Viz (optional)
function addSimpleControllerViz(grip){
  const geo = new THREE.ConeGeometry(0.01, 0.08, 16);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8888ff, metalness: 0, roughness: 0.9 });
  const cone = new THREE.Mesh(geo, mat);
  cone.rotation.x = Math.PI / 2;
  cone.position.z = -0.04;
  grip.add(cone);
}

// Ray-Linie addieren
function buildControllerRay(controller){
  const geometry = new THREE.BufferGeometry().setFromPoints([ new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1) ]);
  const material = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7 });
  const line = new THREE.Line(geometry, material);
  line.name = 'ray';
  line.scale.z = 1.5; // 1.5 m
  controller.add(line);
}

// ==============================
// Schüsse / Bälle
// ==============================
const balls = []; // { mesh, body, bornAt }
const BALL_RADIUS   = 0.02;      // 2 cm Radius
const BALL_MASS     = 0.003;     // ~3 g
const BALL_SPEED    = 3.5;       // m/s
const BALL_LIMIT    = 200;
const BALL_LIFETIME = 20 * 1000; // 20 s

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

function clearAllBalls() {
  while (balls.length) removeBall(balls[0]);
}

// Schuss aus linker Hand
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

// ==============================
// Boden setzen (Reticle)
function lockFloorAtReticle() {
  floorLocked = true;
  const y = reticle.position.y;
  groundBody.position.y = y;
  grid.position.y = y;
  setSignText("✅ Boden gesetzt.\nLinker Trigger: Bälle feuern\nRechter Trigger: Fläche platzieren\n🧹 Button: Alle Bälle löschen");
  showHint(`✅ Boden gesetzt (y=${y.toFixed(2)} m).`);
}

// ==============================
// Manuelle Flächen (Box) – wie in M6
const colliders = []; // { mesh, body }
const DEFAULT_W = 1.0, DEFAULT_H = 1.0, THICK = 0.02;

function addPlaneColliderAtHit(pose) {
  const { position, orientation } = pose.transform;
  const q = orientation;

  // Sichtbare Plane-Box
  const geo = new THREE.BoxGeometry(DEFAULT_W, THICK, DEFAULT_H);
  const mat = new THREE.MeshStandardMaterial({ color: 0x00ff88, transparent: true, opacity: 0.25 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(position.x, position.y, position.z);
  mesh.quaternion.set(q.x, q.y, q.z, q.w);
  scene.add(mesh);

  // Physik
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
// M7: Raum-Mesh → CANNON.Trimesh
// ==============================
const meshMap = new Map(); // XRMesh -> { body, debugMesh?, lastChangedTime }

function handleDetectedMeshes(frame) {
  const detected = frame.detectedMeshes;
  if (!detected) return;

  let count = 0;
  const seen = new Set();

  for (const xrmesh of detected) {
    if (count >= MAX_MESHES) break;

    if (ACCEPT_SEMANTICS && xrmesh.semanticLabel && !ACCEPT_SEMANTICS.includes(xrmesh.semanticLabel)) {
      continue;
    }

    const pose = frame.getPose(xrmesh.meshSpace, refSpace);
    if (!pose) continue;

    const rec = meshMap.get(xrmesh);
    const changed = !rec || (xrmesh.lastChangedTime > (rec.lastChangedTime ?? -1));

    if (!rec) {
      const shape = createTrimeshShapeCapped(xrmesh.vertices, xrmesh.indices);
      if (!shape) continue;

      const body = new CANNON.Body({ mass: 0, material: matWorld });
      body.addShape(shape);
      const p = pose.transform.position;
      const q = pose.transform.orientation;
      body.position.set(p.x, p.y, p.z);
      body.quaternion.set(q.x, q.y, q.z, q.w);
      world.addBody(body);

      let debugMesh = null;
      if (ENABLE_MESH_DEBUG) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(xrmesh.vertices, 3));
        geom.setIndex(new THREE.BufferAttribute(xrmesh.indices, 1));
        const mat = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.15 });
        debugMesh = new THREE.Mesh(geom, mat);
        debugMesh.position.set(p.x, p.y, p.z);
        debugMesh.quaternion.set(q.x, q.y, q.z, q.w);
        scene.add(debugMesh);
      }

      meshMap.set(xrmesh, { body, debugMesh, lastChangedTime: xrmesh.lastChangedTime });
    } else {
      const p = pose.transform.position;
      const q = pose.transform.orientation;
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
          world.addBody(newBody);
          rec.body = newBody;

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

  try {
    return new CANNON.Trimesh(verticesTyped, indices);
  } catch (e) {
    console.warn('Trimesh-Erstellung fehlgeschlagen:', e);
    return null;
  }
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
// In-Scene UI: Schild + Button
// ==============================

// 1) Schild (CanvasTexture)
const { signMesh, setSignText } = createBillboardSign(
  "👀 Schaue auf den Boden und platziere das Reticle.\nDrücke den TRIGGER der LINKEN Hand, um die Bodenhöhe zu setzen."
);
scene.add(signMesh);

// 2) Button „Alle Bälle löschen“
const { buttonRoot, buttonFront, setButtonState } = createClearBallsButton();
scene.add(buttonRoot);

// Interaktives Array für Raycaster
const interactive = [buttonFront];

// Raycaster + Hover-State
const raycaster = new THREE.Raycaster();
let hovered = null;

function tryPressUIButton(controller) {
  // Ray von Controller ableiten
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, -1);
  controller.updateMatrixWorld(true);
  origin.setFromMatrixPosition(controller.matrixWorld);
  dir.applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(controller.matrixWorld)).normalize();

  raycaster.set(origin, dir);
  raycaster.far = 3.0;
  const hits = raycaster.intersectObjects(interactive, false);
  if (hits.length > 0) {
    const obj = hits[0].object;
    if (obj === buttonFront) {
      clearAllBalls();
      setSignText("🧹 Alle Bälle gelöscht.\nLinker Trigger: Bälle • Rechter Trigger: Fläche • Reticle: Boden setzen");
      flashButton(buttonRoot);
      return true;
    }
  }
  return false;
}

function updateUIBillboard() {
  // Schild und Button 0.7 m vor die Kamera, Schild mittig, Button rechts daneben
  const dist = 0.7;
  const offsetSign = new THREE.Vector3(-0.08, -0.12, -dist);
  const offsetButton = new THREE.Vector3(0.22, -0.12, -dist);

  signMesh.position.copy(camera.localToWorld(offsetSign.clone()));
  buttonRoot.position.copy(camera.localToWorld(offsetButton.clone()));

  // Billboard: immer zur Kamera ausgerichtet
  signMesh.quaternion.copy(camera.quaternion);
  buttonRoot.quaternion.copy(camera.quaternion);
}

function updateUIHover(controller) {
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
    setButtonState(hovered === buttonFront ? 'hover' : 'idle');
  }
}

// Schild (Canvas) erstellen
function createBillboardSign(initialText) {
  const w = 1024, h = 512; // 2:1
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  function draw(text) {
    ctx.clearRect(0,0,w,h);
    // Hintergrund mit Rand
    ctx.fillStyle = 'rgba(20,20,20,0.75)';
    roundRect(ctx, 20, 20, w-40, h-40, 28, true, false);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 4;
    roundRect(ctx, 20, 20, w-40, h-40, 28, false, true);

    // Text
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
  texture.needsUpdate = true;

  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
  const geo = new THREE.PlaneGeometry(0.48, 0.24);
  const mesh = new THREE.Mesh(geo, mat);

  function setText(t) { draw(t); texture.needsUpdate = true; }

  // initial
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

// Button erstellen
function createClearBallsButton() {
  const root = new THREE.Group();

  // Korpus (leicht transparent)
  const bodyGeo = new THREE.BoxGeometry(0.16, 0.06, 0.02);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0, roughness: 1, transparent: true, opacity: 0.85 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  root.add(body);

  // Front mit Text (Plane + CanvasTexture)
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
  tex.needsUpdate = true;
  const frontMat = new THREE.MeshBasicMaterial({ map: tex });
  const frontGeo = new THREE.PlaneGeometry(0.145, 0.045);
  const front = new THREE.Mesh(frontGeo, frontMat);
  front.position.z = 0.011; // leicht vor dem Korpus
  root.add(front);

  function setState(state) { drawFront(state); tex.needsUpdate = true; }

  // Für Raycast nur die Front anklickbar
  return { buttonRoot: root, buttonFront: front, setButtonState: setState };
}

// Klick-Feedback (kleiner Push-In)
function flashButton(root) {
  const start = performance.now();
  const dur = 120;
  const base = root.position.z;
  function tick() {
    const t = performance.now() - start;
    const k = Math.min(1, t / dur);
    root.position.z = base - 0.01 * Math.sin(k * Math.PI); // rein & raus
    if (k < 1) requestAnimationFrame(tick);
    else root.position.z = base;
  }
  tick();
}

// ==============================
// Resize
// ==============================
window.addEventListener('resize', onWindowResize, false);
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ==============================
// Loop (Physik + Hit-Test + Mesh + UI)
// ==============================
const fixedTimeStep = 1 / 60;

renderer.setAnimationLoop((_, frame) => {
  // Physik
  world.step(fixedTimeStep);

  // Despawn der Bälle
  const now = performance.now();
  for (let i = balls.length - 1; i >= 0; i--) {
    if (now - balls[i].bornAt > BALL_LIFETIME) removeBall(balls[i]);
  }

  // XR Hit-Test (Reticle)
  if (frame && hitTestSource && refSpace) {
    const results = frame.getHitTestResults(hitTestSource);
    if (results && results.length > 0) {
      const pose = results[0].getPose(refSpace);
      if (pose) {
        lastHitPose = pose;
        reticle.visible = !floorLocked; // Reticle nur bis zum Setzen
        reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
      }
    } else {
      if (!floorLocked) reticle.visible = false;
      lastHitPose = null;
    }
  }

  // M7: Raum-Mesh verarbeiten
  if (frame && typeof frame.detectedMeshes !== 'undefined' && refSpace) {
    handleDetectedMeshes(frame);
  }

  // Three <-> Physik sync (nur Bälle)
  syncMeshesFromPhysics();

  // UI positionieren (vor der Kamera) & Hover mit beiden Controllern
  updateUIBillboard();
  if (leftController)  updateUIHover(leftController);
  if (rightController) updateUIHover(rightController);

  renderer.render(scene, camera);
});

// ==============================
// UI-Helfer (Screen-Hint unten links)
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
