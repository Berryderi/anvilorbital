// Simulator concept steps (WQ-028): 03 tug mission and 05 wait vs burn. Concepts, not built: every object here is
// drawn for illustration and none is a real satellite. The page shows the numbers (research out/sim-numbers.md);
// this module only draws, from the orbit heights and angles named below.
import * as THREE from 'three';

const R_EARTH_KM = 6371;
const UNIT_KM = 1000;
const HEIGHT_X = 4;                              // heights drawn 4 times taller than real, as in step 02; the page says so
const r = km => (R_EARTH_KM + HEIGHT_X * km) / UNIT_KM;
const DEG = Math.PI / 180;

// 03 tug, sim-numbers S1 and R1: station at 700 km; retirees in the same plane, 150 km above or 100 km below.
const STATION_KM = 700, RETIREE_KM = [850, 600];
const TRIP_S = 9;                                // one round trip on screen; the page's day counter runs 0 to 50 over it
const LAP_S = 14;                                // one lap of the station ring, for the eye only
const LEAD_RAD = 1.1;                            // how far ahead of the station each retiree waits
const TUG_PHASE = { undock: 0.06, arrive: 0.40, leave: 0.52, dock: 0.88 };
const TRAIL_N = 90, TRAIL_DT_S = 0.045;          // trail: tug positions over the last ~4 s
// 05 wait vs burn, sim-numbers W1 and S1, W3: a 45° node gap between two sun-synchronous planes (98.2°); the tug waits
// in a lower drift orbit (564 km, W3's Cerf-style case) while Earth's bulge turns its plane into line.
const GAP_DEG = 45, INCL_DEG = 98.2, TARGET_KM = 700, DRIFT_KM = 564;
const WAIT_S = 10, WAIT_ALIGN = 0.75;            // drift for the first 75% of the loop, then hold aligned
const WAIT_LAP_S = 7;

const MARK_VS = `
attribute float aSize; attribute vec3 aColor; varying vec3 vC;
void main() { vC = aColor; gl_PointSize = aSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const MARK_FS = `
varying vec3 vC;
void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); a = a * a * 0.6 + smoothstep(0.38, 0.18, d) * 0.9; if (a < 0.01) discard;
  gl_FragColor = vec4(vC * a, a);
  #include <colorspace_fragment>
}`;
// A thin glowing shell at one height: bright toward its limb, nearly clear face-on.
const SHELL_VS = `
varying vec3 vN; varying vec3 vP;
void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const SHELL_FS = `
uniform vec3 uColor; uniform float uStrength; varying vec3 vN; varying vec3 vP;
void main() { float f = 1.0 - abs(dot(normalize(vN), normalize(cameraPosition - vP))); float a = pow(f, 4.0) * uStrength;
  gl_FragColor = vec4(uColor * a, a);
  #include <colorspace_fragment>
}`;

export function makeShell(radius, color, strength = 0.35) {
  const m = new THREE.ShaderMaterial({ vertexShader: SHELL_VS, fragmentShader: SHELL_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } } });
  const s = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), m);
  s.scale.setScalar(radius); s.renderOrder = 3;
  return s;
}

function ring(radius, color, opacity, dashed = false, segments = 192) {
  const pts = [];
  for (let i = 0; i <= segments; i++) { const a = i / segments * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius)); }
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const m = dashed ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.22, gapSize: 0.18, depthWrite: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const l = new THREE.Line(g, m); if (dashed) l.computeLineDistances();
  l.renderOrder = 4;
  return l;
}

export function markers(n, pr) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
  const p = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: MARK_VS, fragmentShader: MARK_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  p.frustumCulled = false; p.renderOrder = 6; p.userData.pr = pr;
  return p;
}
export function setMark(p, i, pos, color, sizeCss) {
  const g = p.geometry.attributes;
  g.position.array.set([pos.x, pos.y, pos.z], i * 3); color.toArray(g.aColor.array, i * 3); g.aSize.array[i] = sizeCss * p.userData.pr;
  g.position.needsUpdate = g.aColor.needsUpdate = g.aSize.needsUpdate = true;
}

const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
const clamp01 = x => Math.min(1, Math.max(0, x));

// ---------- 03 Tug ----------
export function createTug(colors, pr) {
  const group = new THREE.Group();
  group.rotation.set(0.38, 0, -0.12);
  const rs = r(STATION_KM), rr = RETIREE_KM.map(r);
  group.add(ring(rs, colors.station, 0.9), ring(rr[0], colors.target, 0.5, true), ring(rr[1], colors.target, 0.5, true), makeShell(rs, colors.station, 0.22));
  const trailG = new THREE.BufferGeometry();
  trailG.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
  trailG.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
  const trail = new THREE.Line(trailG, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  trail.frustumCulled = false; trail.renderOrder = 5;
  const marks = markers(3, pr);
  group.add(trail, marks);

  // Where everything is at time t (seconds of animation). Everything turns together at one rate, for the eye.
  function at(t) {
    const trip = Math.floor(t / TRIP_S), p = (t - trip * TRIP_S) / TRIP_S, rt = rr[trip % 2];
    const theta = t / LAP_S * Math.PI * 2;
    let s;
    if (p < TUG_PHASE.undock) s = 0;
    else if (p < TUG_PHASE.arrive) s = smooth((p - TUG_PHASE.undock) / (TUG_PHASE.arrive - TUG_PHASE.undock));
    else if (p < TUG_PHASE.leave) s = 1;
    else if (p < TUG_PHASE.dock) s = 1 - smooth((p - TUG_PHASE.leave) / (TUG_PHASE.dock - TUG_PHASE.leave));
    else s = 0;
    return { trip, p, s, theta, rt, tugA: theta + LEAD_RAD * s, tugR: rs + (rt - rs) * s };
  }
  const v = new THREE.Vector3(), tmpC = new THREE.Color(), black = new THREE.Color(0, 0, 0);
  const polar = (a, rad, out) => out.set(Math.cos(a) * rad, 0, Math.sin(a) * rad);

  function update(t) {
    const st = at(t);
    setMark(marks, 0, polar(st.theta, rs, v), colors.station, 26);
    setMark(marks, 1, polar(st.tugA, st.tugR, v), colors.ink, 16);
    // The retiree waits ahead on its ring, rides with the tug on the way back, and is gone once docked.
    const towed = st.p >= TUG_PHASE.leave;
    const gone = st.p >= TUG_PHASE.dock;
    if (gone) setMark(marks, 2, v.set(0, 0, 0), black, 0);
    else if (towed) setMark(marks, 2, polar(st.tugA - 0.035, st.tugR, v), colors.target, 18);
    else setMark(marks, 2, polar(st.theta + LEAD_RAD, st.rt, v), colors.target, 18);
    const pos = trailG.attributes.position.array, col = trailG.attributes.color.array;
    for (let k = 0; k < TRAIL_N; k++) {
      const tk = Math.max(0, t - k * TRAIL_DT_S), sk = at(tk);
      polar(sk.tugA, sk.tugR, v); pos.set([v.x, v.y, v.z], k * 3);
      const fade = (1 - k / TRAIL_N) ** 1.6 * (sk.s > 0.002 ? 1 : 0.15);
      tmpC.copy(colors.station).multiplyScalar(fade).toArray(col, k * 3);
    }
    trailG.attributes.position.needsUpdate = trailG.attributes.color.needsUpdate = true;
    const fuel = st.p < TUG_PHASE.arrive ? 0.5 * clamp01((st.p - TUG_PHASE.undock) / (TUG_PHASE.arrive - TUG_PHASE.undock))
      : st.p < TUG_PHASE.leave ? 0.5 : st.p < TUG_PHASE.dock ? 0.5 + 0.5 * clamp01((st.p - TUG_PHASE.leave) / (TUG_PHASE.dock - TUG_PHASE.leave)) : 1;
    const caption = st.p < TUG_PHASE.undock ? 'Undock' : st.p < TUG_PHASE.arrive ? 'Transfer' : st.p < TUG_PHASE.leave ? 'Capture' : st.p < TUG_PHASE.dock ? 'Tow' : 'Dock';
    return { p: st.p, fuel, caption };
  }
  return { group, update, stillT: TRIP_S * 0.84, cameraPos: new THREE.Vector3(5, 17, 29) };
}

// ---------- 05 Wait vs burn ----------
export function createWaitBurn(colors, pr) {
  const group = new THREE.Group();
  const rt = r(TARGET_KM), rd = r(DRIFT_KM);
  // A ring in a plane of inclination i with its ascending node at angle node: tilt about the node line, then turn about
  // the polar axis (scene y, ECI z). Turning about y by the node angle is ECI's turn about z (scene = ECI x, z, -y).
  const plane = (radius, color, opacity, dashed) => {
    const pivot = new THREE.Group(), tilt = new THREE.Group();
    tilt.rotation.x = -INCL_DEG * DEG;
    const l = ring(radius, color, opacity, dashed); tilt.add(l); pivot.add(tilt);
    return { pivot, tilt };
  };
  const target = plane(rt, colors.target, 0.95, false), ghost = plane(rd, colors.ghost, 0.7, true), tug = plane(rd, colors.station, 0.95, false);
  ghost.pivot.rotation.y = GAP_DEG * DEG;
  group.add(target.pivot, ghost.pivot, tug.pivot);
  // Node marker: a short line on the equator plane at each ring's ascending node.
  const marks = markers(2, pr);
  group.add(marks);
  const v = new THREE.Vector3();
  function update(t) {
    const p = (t % WAIT_S) / WAIT_S, d = smooth(Math.min(1, p / WAIT_ALIGN));
    tug.pivot.rotation.y = GAP_DEG * DEG * (1 - d);
    const u = t / WAIT_LAP_S * Math.PI * 2;
    v.set(Math.cos(u) * rt, 0, Math.sin(u) * rt).applyEuler(target.tilt.rotation).applyEuler(target.pivot.rotation);
    setMark(marks, 0, v, colors.target, 18);
    v.set(Math.cos(u + 0.5) * rd, 0, Math.sin(u + 0.5) * rd).applyEuler(tug.tilt.rotation).applyEuler(tug.pivot.rotation);
    setMark(marks, 1, v, colors.station, 22);
    return { p, aligned: p >= WAIT_ALIGN, caption: p >= WAIT_ALIGN ? 'Aligned' : 'Drift' };
  }
  return { group, update, stillT: WAIT_S * 0.45, cameraPos: new THREE.Vector3(21, 10, 21) };
}
