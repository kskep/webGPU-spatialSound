// Mesh (BVH) version of trace.wgsl (old implementation. this is at least x2 faster than my first implementation).
//
// Same uniform block and same 15-float output record per segment as the shoebox
// tracer, so the CPU readback code is shared:
//   [ arrival, band0..band7, -direction.xyz, segmentEnd.xyz ]
// The room shell and any box objects are one triangle list stored in a BVH.
//
// Two ways of ending a ray (Task Q, see src/config/ray-termination.ts):
//   limits.x == 0  legacy: every ray makes exactly `segments` segments and every segment gets a record.
//   limits.x == 1  energy: a ray stops when its strongest band is `termination.x` times its initial
//                  strongest band, when its path is longer than `termination.y` metres, or after
//                  `limits.y` segments. Only the first `segments` (= budget.y) segments get records;
//                  receiver hits of later segments are summed into the late histogram (binding 5).

struct Params {
  room: vec4f,        // shell size (unused here: the shell is triangles)
  source: vec4f,
  listener: vec4f,    // xyz = position, w = receiver radius
  controls: vec4f,    // x = scattering (unused: per-material), y = earlyOrder, z = speed, w = total ray count
  budget: vec4u,      // x = rays in this batch, y = segments per ray, z = seed, w = ray offset
  wallsLow: vec4f, wallsHigh: vec4f,      // shell absorption (unused: per-material)
  floorLow: vec4f, floorHigh: vec4f,
  ceilingLow: vec4f, ceilingHigh: vec4f,
  airLow: vec4f, airHigh: vec4f,          // air attenuation in dB per metre, bands 0-3 / 4-7
  // Source directivity (see src/gpu/directivity-uniform.ts for the layout).
  sourceForward: vec4f,                  // xyz = unit forward vector
  dirAlphaLow: vec4f, dirAlphaHigh: vec4f,
  dirExponentLow: vec4f, dirExponentHigh: vec4f,
  dirNormLow: vec4f, dirNormHigh: vec4f,   // sphere-mean of g^2 per band
  // Ray termination; ignored when limits.x == 0.
  termination: vec4f,   // x = energy cutoff (linear, relative to the initial strongest band), y = path limit in metres,
                        // z = histogram bins per metre of path (1 / (bin seconds * speed)), w unused
  limits: vec4u,        // x = mode (0 bounces, 1 energy), y = maximum segments per ray, z = 1 to tag specular paths, w = histogram bin count
}

struct Node {
  boxMin: vec3f,
  first: u32,   // leaf: first triangle. internal: left child (right child = first + 1)
  boxMax: vec3f,
  count: u32,   // leaf: number of triangles. internal node: 0
}

struct Tri {
  a: vec3f, material: u32,
  b: vec3f, flags: u32,    // flags bit 0 = room-shell triangle (covered by the image-source method)
  c: vec3f, surface: u32,  // surface = id of the flat face the triangle belongs to (the two triangles of a face share it)
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<storage, read> nodes: array<Node>;
@group(0) @binding(3) var<storage, read> tris: array<Tri>;
// Four vec4 per material: absorption bands 0-3, absorption 4-7, scattering 0-3, scattering 4-7.
@group(0) @binding(4) var<storage, read> materials: array<vec4f>;
// Counters and the late histogram (energy mode only; a dummy buffer is bound otherwise).
//   [0] overflows of the fixed-point sums   [1] rays stopped by the energy cutoff   [2] by the path limit
//   [3] by the segment cap                  [4] rays that left the geometry         [5] segments traced
//   [6] longest ray in segments (atomicMax) [7] unused
//   then per bin 17 words: for each band the low and high word of the 64-bit fixed-point energy sum, and the hit count.
@group(0) @binding(5) var<storage, read_write> late: array<atomic<u32>>;
// Specular path tags, two words per detailed segment, laid out like the records of `output`
// (index = ray * segments + bounce). Written only when limits.z == 1; a 16-byte dummy is bound otherwise.
//   x = FNV-1a hash of the surface ids the ray reflected from before this segment, in order
//   y = (id of the surface this segment ends on) * 2 + 1 if every reflection so far was specular, else 0
// The CPU groups the receiver hits that have y & 1 by (segment index, x). Buffers start zeroed, so an
// unwritten segment reads as "not specular".
@group(0) @binding(6) var<storage, read_write> specular: array<vec2u>;

const STACK_SIZE = 64u;
const SHELL_FLAG = 1u;
const COUNTER_WORDS = 8u;
const BIN_WORDS = 17u;
const END_ENERGY = 1u;
const END_TIME = 2u;
const END_CAP = 3u;
const END_LOST = 4u;
// Late-histogram fixed point: 1 unit = 2^-52 of the normalised received energy (see ray-termination.ts).
const HISTOGRAM_SCALE = 4503599627370496.0;   // 2^52
const TWO_POW_32 = 4294967296.0;
const RAY_EPSILON = 0.00001;     // minimum accepted hit distance
const SURFACE_OFFSET = 0.0001;   // push the new origin off the surface along the normal
const HASH_START = 2166136261u;  // FNV-1a offset basis
const HASH_PRIME = 16777619u;    // FNV-1a prime

var<private> rng: u32;

// xorshift32, identical to trace.wgsl.
fn random() -> f32 {
  rng ^= rng << 13u;
  rng ^= rng >> 17u;
  rng ^= rng << 5u;
  return f32(rng >> 8u) / 16777216.0;
}

// Uniform point on the unit sphere.
fn sphere() -> vec3f {
  // EDW DEIGMATOLIPTOUME OMOIOMORFA STI SFAIRA GIA NA EKPEMPOUME RAYS PROS OLES TIS KATEFTHYNSEIS.
  let z = 2.0 * random() - 1.0;
  let phi = 6.28318530718 * random();
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(phi), z, r * sin(phi));
}

// Normalised energy weight g^2(theta) / N of one group of four bands, theta = launch direction vs forward.
// alpha == 1 is the omnidirectional pattern: the weight is then exactly 1 (not pow() rounding), so
// an omni source reproduces the results from before directivity existed bit for bit.
fn directivityWeight(cosTheta: f32, alpha: vec4f, exponent: vec4f, norm: vec4f) -> vec4f {
  let pressureBase = max(abs(alpha + (vec4f(1.0) - alpha) * cosTheta), vec4f(1e-30));
  let weight = pow(pressureBase, 2.0 * exponent) / norm;
  return select(weight, vec4f(1.0), alpha >= vec4f(1.0));
}

// Energy remaining after travelling `length` metres with attenuation `db` dB/m.
fn air(db: vec4f, length: f32) -> vec4f {
  return exp(-db * length * 0.2302585093);
}

// Slab test: true when the ray enters the box before `tMax`.
fn hitsBox(origin: vec3f, inverseDirection: vec3f, boxMin: vec3f, boxMax: vec3f, tMax: f32) -> bool {
  let t0 = (boxMin - origin) * inverseDirection;
  let t1 = (boxMax - origin) * inverseDirection;
  let near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.0));
  let far = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), tMax));
  return near <= far;
}

// Moller-Trumbore ray/triangle test. Returns the hit distance or a huge value on a miss.
// Triangles are two-sided, so the sign of the determinant is not used for culling.
fn intersectTriangle(origin: vec3f, direction: vec3f, tri: Tri) -> f32 {
  let edge1 = tri.b - tri.a;
  let edge2 = tri.c - tri.a;
  let pvec = cross(direction, edge2);
  let det = dot(edge1, pvec);
  if (abs(det) < 1e-12) { return 1e20; }
  let inverseDet = 1.0 / det;
  let toOrigin = origin - tri.a;
  let u = dot(toOrigin, pvec) * inverseDet;
  // A tiny negative tolerance closes cracks along shared triangle edges.
  if (u < -1e-6 || u > 1.0 + 1e-6) { return 1e20; }
  let qvec = cross(toOrigin, edge1);
  let v = dot(direction, qvec) * inverseDet;
  if (v < -1e-6 || u + v > 1.0 + 1e-6) { return 1e20; }
  let t = dot(edge2, qvec) * inverseDet;
  return select(1e20, t, t > RAY_EPSILON);
}

struct ClosestHit {
  t: f32,        // 1e20 when nothing was hit
  triangle: u32,
}

// Closest hit by iterative BVH traversal.
//  - `stack` holds node indices still to visit (no recursion in WGSL).
//  - Pop a node; skip it if its box is missed or lies beyond the closest hit found so far.
//  - Internal node: push both children. Leaf: test each of its triangles.
fn closestHit(origin: vec3f, direction: vec3f) -> ClosestHit {
  // Avoid dividing by zero for axis-parallel rays.
  let safeDirection = select(direction, vec3f(1e-8), abs(direction) < vec3f(1e-8));
  let inverseDirection = 1.0 / safeDirection;

  var stack: array<u32, STACK_SIZE>;
  var stackSize = 1u;
  stack[0] = 0u; // root node

  var best = ClosestHit(1e20, 0u);
  while (stackSize > 0u) {
    stackSize -= 1u;
    let node = nodes[stack[stackSize]];
    if (!hitsBox(origin, inverseDirection, node.boxMin, node.boxMax, best.t)) { continue; }
    if (node.count == 0u) {
      if (stackSize + 2u <= STACK_SIZE) {
        stack[stackSize] = node.first;
        stack[stackSize + 1u] = node.first + 1u;
        stackSize += 2u;
      }
    } else {
      for (var i = node.first; i < node.first + node.count; i++) {
        let t = intersectTriangle(origin, direction, tris[i]);
        if (t < best.t) { best = ClosestHit(t, i); }
      }
    }
  }
  return best;
}

// Fills the unused detailed records of a ray with empty ones: no arrival, no energy, end point at `origin`.
fn emptyRecords(ray: u32, first: u32, stride: u32, origin: vec3f) {
  for (var rest = first; rest < stride; rest++) {
    let emptyBase = (ray * stride + rest) * 15u;
    for (var k = 0u; k < 15u; k++) { output[emptyBase + k] = 0.0; }
    output[emptyBase] = -1.0;
    output[emptyBase + 12u] = origin.x;
    output[emptyBase + 13u] = origin.y;
    output[emptyBase + 14u] = origin.z;
  }
}

// Adds `value` (>= 0) to a 64-bit fixed-point sum held in two u32 words at late[word] (low) and late[word + 1] (high).
// scaled = value * 2^52 is split exactly into scaled = high * 2^32 + low; a carry out of the low word goes to the high word.
fn addFixed(word: u32, value: f32) {
  if (value <= 0.0) { return; }
  // EDW METATREPOUME TIN ENERGEIA SE FIXED POINT GIA NA KANOUME ATOMIC ATHROISI XWRIS FLOAT ATOMICS.
  let scaled = value * HISTOGRAM_SCALE;
  let high = floor(scaled / TWO_POW_32);
  let lowUnits = u32(round(scaled - high * TWO_POW_32));
  let previousLow = atomicAdd(&late[word], lowUnits);
  let carry = select(0u, 1u, previousLow + lowUnits < previousLow);
  let highUnits = u32(high) + carry;
  if (highUnits != 0u) {
    let previousHigh = atomicAdd(&late[word + 1u], highUnits);
    if (previousHigh + highUnits < previousHigh) { atomicAdd(&late[0], 1u); }
  }
}

// Records the end of a ray in the counters (energy mode only): why it stopped and how many segments it made.
fn countRay(reason: u32, segmentsTraced: u32) {
  atomicAdd(&late[reason], 1u);
  atomicAdd(&late[5], segmentsTraced);
  atomicMax(&late[6], segmentsTraced);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.budget.x) { return; }
  // Same per-ray seeding as trace.wgsl.
  rng = (id.x + p.budget.w + 1u) * 747796405u + p.budget.z * 2891336453u + 1u;
  if (rng == 0u) { rng = 1u; }

  var origin = p.source.xyz;
  var direction = sphere();
  var length = 0.0;
  // Running energy per band. It starts at the source directivity importance weight: the launch
  // direction stays uniform and the normalised weight has mean 1, so the estimator is unbiased.
  let launchCos = dot(direction, p.sourceForward.xyz);
  var low = directivityWeight(launchCos, p.dirAlphaLow, p.dirExponentLow, p.dirNormLow);    // bands 0-3
  var high = directivityWeight(launchCos, p.dirAlphaHigh, p.dirExponentHigh, p.dirNormHigh); // bands 4-7
  var scattered = false;       // a diffuse reflection has happened
  var touchedObject = false;   // a non-shell triangle has been hit
  let tagSpecular = p.limits.z == 1u;
  var pathHash = HASH_START;   // hash of the surface ids reflected from so far (only meaningful while !scattered)
  let earlyOrder = u32(p.controls.y);
  // `segments` is the number of detailed records per ray (the record stride). Legacy mode traces exactly that
  // many segments; energy mode keeps going until a termination rule applies, up to `limits.y` segments.
  let segments = p.budget.y;
  let energyMode = p.limits.x == 1u;
  let loopLimit = select(segments, p.limits.y, energyMode);
  let strongestStart = max(max(max(low.x, low.y), max(low.z, low.w)), max(max(high.x, high.y), max(high.z, high.w)));
  let cutoffEnergy = strongestStart * p.termination.x;
  var endReason = END_CAP;
  var segmentsTraced = loopLimit;

  for (var bounce = 0u; bounce < loopLimit; bounce++) {
    if (energyMode && bounce > 0u) {
      let strongest = max(max(max(low.x, low.y), max(low.z, low.w)), max(max(high.x, high.y), max(high.z, high.w)));
      if (strongest <= cutoffEnergy) { endReason = END_ENERGY; segmentsTraced = bounce; break; }
      if (length >= p.termination.y) { endReason = END_TIME; segmentsTraced = bounce; break; }
    }
    let hit = closestHit(origin, direction);

    // The ray left the geometry (only possible through a numerical crack).
    // Every output slot must still be written, so fill the rest with empty records.
    if (hit.t >= 1e19) {
      emptyRecords(id.x, bounce, segments, origin);
      if (energyMode) { countRay(END_LOST, bounce); }
      return;
    }

    let tri = tris[hit.triangle];
    let t = hit.t;
    let end = origin + direction * t;

    // Receiver sphere test, done before the surface so that surfaces occlude the listener.
    let along = dot(p.listener.xyz - origin, direction);

    // Collection rule. The image-source method (ISM) already supplies every UNSCATTERED
    // path that only touched the room shell, up to earlyOrder reflections. Collecting
    // those here would count them twice. Everything else is ours:
    //   - paths that had a diffuse reflection (ISM cannot represent them),
    //   - paths that touched an object (ISM only knows the empty shell),
    //   - shell-only specular paths beyond earlyOrder (the late tail).
    // EDW APOKLEIOUME TA EARLY PATHS TOU IMAGE-SOURCE GIA NA MIN METRAME DIPLI ENERGEIA.
    let collect = bounce > 0u && (scattered || touchedObject || bounce > earlyOrder);

    var arrival = -1.0;
    var receivedLow = vec4f(0.0);
    var receivedHigh = vec4f(0.0);
    if (collect && along > 0.0 && along < t
        && distance(origin + direction * along, p.listener.xyz) < p.listener.w) {
      arrival = length + along;
      // Normalise by ray count and receiver cross-section so the sum is an energy density.
      let norm = p.controls.w * 3.14159265359 * p.listener.w * p.listener.w;
      receivedLow = low * air(p.airLow, along) / norm;
      receivedHigh = high * air(p.airHigh, along) / norm;
    }

    if (bounce < segments) {
      // Output record for this segment.
      let base = (id.x * segments + bounce) * 15u;
      output[base] = arrival;
      for (var band = 0u; band < 4u; band++) {
        output[base + 1u + band] = receivedLow[band];
        output[base + 5u + band] = receivedHigh[band];
      }
      output[base + 9u] = -direction.x;
      output[base + 10u] = -direction.y;
      output[base + 11u] = -direction.z;
      output[base + 12u] = end.x;
      output[base + 13u] = end.y;
      output[base + 14u] = end.z;
      if (tagSpecular) {
        specular[id.x * segments + bounce] = vec2u(pathHash, select(0u, tri.surface * 2u + 1u, !scattered));
      }
    } else if (arrival > 0.0) {
      // Beyond the detailed segments (energy mode): sum the hit into the late histogram.
      let bin = u32(arrival * p.termination.z);
      if (bin < p.limits.w) {
        let word = COUNTER_WORDS + bin * BIN_WORDS;
        for (var band = 0u; band < 4u; band++) {
          addFixed(word + 2u * band, receivedLow[band]);
          addFixed(word + 2u * (band + 4u), receivedHigh[band]);
        }
        atomicAdd(&late[word + 16u], 1u);
      }
    }

    // Two-sided geometric normal, flipped to face the incoming ray.
    var normal = normalize(cross(tri.b - tri.a, tri.c - tri.a));
    if (dot(normal, direction) > 0.0) { normal = -normal; }

    // Per-band absorption and scattering of the triangle's material.
    let m = tri.material * 4u;
    let absorptionLow = materials[m];
    let absorptionHigh = materials[m + 1u];
    let scatterLow = materials[m + 2u];
    let scatterHigh = materials[m + 3u];

    // Propagate: air loss over the segment, then surface absorption.
    low *= air(p.airLow, t) * (vec4f(1.0) - absorptionLow);
    high *= air(p.airHigh, t) * (vec4f(1.0) - absorptionHigh);
    length += t;
    origin = end + normal * SURFACE_OFFSET;
    if ((tri.flags & SHELL_FLAG) == 0u) { touchedObject = true; }
    if (tagSpecular) { pathHash = (pathHash ^ tri.surface) * HASH_PRIME; }

    // Frequency-dependent scattering with ONE ray.
    // Scattering s_b differs per band, but a ray can only take one direction. So pick
    // the branch with the band-averaged probability sMean and re-weight each band:
    //   diffuse  (probability sMean)     : energy_b *= s_b / sMean
    //   specular (probability 1 - sMean) : energy_b *= (1 - s_b) / (1 - sMean)
    // Expected weight of band b = sMean*(s_b/sMean) + (1-sMean)*((1-s_b)/(1-sMean)) = 1
    // for the diffuse and specular energy shares s_b and (1 - s_b), so each band is
    // unbiased. For a uniform s the weights are exactly 1, which is trace.wgsl.
    // EDW EPILEGOUME DIAXYTI I KATOPTRIKI ANAKLASI KAI DIORTHWNOUME TA BAND VARI GIA TO SWSTO EXPECTED ENERGY.
    let meanScatter = (dot(scatterLow, vec4f(1.0)) + dot(scatterHigh, vec4f(1.0))) / 8.0;
    var goDiffuse = false;
    if (meanScatter >= 1.0) {
      goDiffuse = true;        // always diffuse; weights s_b / 1 = s_b = 1
    } else if (meanScatter > 0.0) {
      goDiffuse = random() < meanScatter;
    }                          // meanScatter == 0: always specular, weights stay 1
    if (goDiffuse) {
      low *= scatterLow / max(meanScatter, 1e-6);
      high *= scatterHigh / max(meanScatter, 1e-6);
      direction = normalize(normal + sphere());   // cosine-weighted about the normal
      scattered = true;
    } else {
      let specularNorm = max(1.0 - meanScatter, 1e-6);
      low *= (vec4f(1.0) - scatterLow) / specularNorm;
      high *= (vec4f(1.0) - scatterHigh) / specularNorm;
      direction = reflect(direction, normal);
    }
  }

  // The ray ended by a rule (or ran to the cap). Unused detailed records must still be written.
  if (segmentsTraced < segments) { emptyRecords(id.x, segmentsTraced, segments, origin); }
  if (energyMode) { countRay(endReason, segmentsTraced); }
}
