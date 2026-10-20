// Old implemenation where i stored everything in the ray
// Output record per segment (15 floats), identical to mesh-trace.wgsl so the CPU readback is shared:
//   [ arrival, energy bands 0..7, -direction.xyz, segmentEnd.xyz ]
// `arrival` is the total path length in metres when the segment crosses the receiver sphere, else -1.

struct Params {
  room: vec4f,
  source: vec4f,
  listener: vec4f,   // xyz = position, w = receiver radius
  controls: vec4f,   // x = scattering (unused: per-surface bands below), y = earlyOrder, z = speed, w = total ray count
  budget: vec4u,     // x = rays in this batch, y = segments per ray, z = seed, w = ray offset
  wallsLow: vec4f,
  wallsHigh: vec4f,
  floorLow: vec4f,
  floorHigh: vec4f,
  ceilingLow: vec4f,
  ceilingHigh: vec4f,
  airLow: vec4f,     // air attenuation in dB per metre, bands 0-3
  airHigh: vec4f,    // bands 4-7
  // Source directivity (see src/gpu/directivity-uniform.ts for the layout).
  sourceForward: vec4f,   // xyz = unit forward vector
  dirAlphaLow: vec4f,
  dirAlphaHigh: vec4f,
  dirExponentLow: vec4f,
  dirExponentHigh: vec4f,
  dirNormLow: vec4f,      // sphere-mean of g^2 per band
  dirNormHigh: vec4f,
  // Shell scattering per band, after the directivity block (floats 80..103).
  wallsScatterLow: vec4f,
  wallsScatterHigh: vec4f,
  floorScatterLow: vec4f,
  floorScatterHigh: vec4f,
  ceilingScatterLow: vec4f,
  ceilingScatterHigh: vec4f,
  // Band mean of each surface's scattering, computed on the CPU (floats 104..107): x walls, y floor,
  // z ceiling. Not summed in the shader, so a uniform surface has a mean that is bitwise its value.
  scatterMean: vec4f,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;

var<private> rng: u32;

// xorshift32 returning a float in [0, 1).
fn random() -> f32 {
  rng ^= rng << 13u;
  rng ^= rng >> 17u;
  rng ^= rng << 5u;
  return f32(rng >> 8u) / 16777216.0;
}

// Uniform point on the unit sphere.
fn sphere() -> vec3f {
  let z = 2.0 * random() - 1.0;
  let phi = 6.28318530718 * random();
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(phi), z, r * sin(phi));
}

// Energy remaining after travelling `length` metres with attenuation `db` dB/m.
fn air(db: vec4f, length: f32) -> vec4f {
  // EDW METATREPOUME TA dB AERA SE GRAMMIKO ENERGY FACTOR GIA TO MIKOS TIS DIADROMIS.
  return exp(-db * length * 0.2302585093);
}

// Normalised energy weight g^2(theta) / N of one group of four bands, theta = launch direction vs forward.
// alpha == 1 is the omnidirectional pattern: the weight is then exactly 1 (not pow() rounding), so
// an omni source reproduces the results from before directivity existed bit for bit.
fn directivityWeight(cosTheta: f32, alpha: vec4f, exponent: vec4f, norm: vec4f) -> vec4f {
  let pressureBase = max(abs(alpha + (vec4f(1.0) - alpha) * cosTheta), vec4f(1e-30));
  let weight = pow(pressureBase, 2.0 * exponent) / norm;
  return select(weight, vec4f(1.0), alpha >= vec4f(1.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.budget.x) {
    return;
  }

  // Per-ray random seed from the global ray index, the batch offset and the user seed.
  rng = (id.x + p.budget.w + 1u) * 747796405u + p.budget.z * 2891336453u + 1u;
  if (rng == 0u) {
    rng = 1u;
  }

  var origin = p.source.xyz;
  var direction = sphere();
  var length = 0.0;

  // Importance weight for the source directivity. The launch direction stays uniform, so the
  // estimator is unbiased because the normalised weight has mean 1 over the sphere.
  let launchCos = dot(direction, p.sourceForward.xyz);
  var low = directivityWeight(launchCos, p.dirAlphaLow, p.dirExponentLow, p.dirNormLow);
  var high = directivityWeight(launchCos, p.dirAlphaHigh, p.dirExponentHigh, p.dirNormHigh);
  var scattered = false;

  for (var bounce = 0u; bounce < p.budget.y; bounce++) {
    // Nearest wall along the ray: slab test on the three axis-aligned wall pairs.
    var t = 1e20;
    var normal = vec3f(0.0);
    var hitAxis = 0u;
    for (var axis = 0u; axis < 3u; axis++) {
      if (abs(direction[axis]) > 1e-8) {
        // The room spans [-size/2, size/2] on x and z, and [0, size] on y (floor at 0).
        let minWall = select(-p.room[axis] * 0.5, 0.0, axis == 1u);
        let maxWall = select(p.room[axis] * 0.5, p.room[axis], axis == 1u);
        let wall = select(minWall, maxWall, direction[axis] > 0.0);
        let candidate = (wall - origin[axis]) / direction[axis];
        if (candidate > 0.00001 && candidate < t) {
          t = candidate;
          normal = vec3f(0.0);
          normal[axis] = select(1.0, -1.0, direction[axis] > 0.0);
          hitAxis = axis;
        }
      }
    }

    let end = origin + direction * t;
    let along = dot(p.listener.xyz - origin, direction);
    var arrival = -1.0;
    var receivedLow = vec4f(0.0);
    var receivedHigh = vec4f(0.0);

    // ISM owns all unscattered paths through earlyOrder. Diffuse histories stay stochastic.
    if ((bounce > u32(p.controls.y) || scattered) && bounce > 0u) {
      // Does the segment pass through the receiver sphere?
      if (along > 0.0 && along < t && distance(origin + direction * along, p.listener.xyz) < p.listener.w) {
        arrival = length + along;
        // Energy per unit receiver cross-section: divide by (rays * pi * r^2).
        let norm = p.controls.w * 3.14159265359 * p.listener.w * p.listener.w;
        receivedLow = low * air(p.airLow, along) / norm;
        receivedHigh = high * air(p.airHigh, along) / norm;
      }
    }

    // Write the segment record.
    let base = (id.x * p.budget.y + bounce) * 15u;
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

    // Wall absorption: floor and ceiling have their own coefficients, the four side walls share one.
    var absorptionLow = p.wallsLow;
    var absorptionHigh = p.wallsHigh;
    if (hitAxis == 1u) {
      if (normal.y > 0.0) {
        absorptionLow = p.floorLow;
        absorptionHigh = p.floorHigh;
      } else {
        absorptionLow = p.ceilingLow;
        absorptionHigh = p.ceilingHigh;
      }
    }

    // Lose energy to the air over the segment and to the wall at its end.
    low *= air(p.airLow, t) * (vec4f(1.0) - absorptionLow);
    high *= air(p.airHigh, t) * (vec4f(1.0) - absorptionHigh);
    length += t;

    // Scattering of the surface that was hit, per band.
    var scatterLow = p.wallsScatterLow;
    var scatterHigh = p.wallsScatterHigh;
    if (hitAxis == 1u) {
      if (normal.y > 0.0) {
        scatterLow = p.floorScatterLow;
        scatterHigh = p.floorScatterHigh;
      } else {
        scatterLow = p.ceilingScatterLow;
        scatterHigh = p.ceilingScatterHigh;
      }
    }

    // Frequency-dependent scattering with ONE ray (the estimator of mesh-trace.wgsl).
    // A ray takes one direction, so choose the diffuse branch with the band-averaged probability
    // sMean and re-weight each band so that it stays unbiased:
    //   diffuse  (probability sMean)     : energy_b *= s_b / sMean
    //   specular (probability 1 - sMean) : energy_b *= (1 - s_b) / (1 - sMean)
    // A band whose s equals sMean has weight 1 by definition. It is SELECTED, not computed as x / x,
    // because GPU division is not guaranteed to return exactly 1.0 for equal operands. With that,
    // and because the random number is drawn in every case (also for s = 0 and s = 1), a uniform
    // shell reproduces the pre-Task-N numbers bit for bit.
    // The divisions are safe: the diffuse branch needs random() < sMean (so sMean > 0), and the
    // specular branch needs random() >= sMean with random() < 1 (so sMean < 1).
    var meanScatter = p.scatterMean.x;
    if (hitAxis == 1u) {
      meanScatter = select(p.scatterMean.z, p.scatterMean.y, normal.y > 0.0);
    }
    origin = end + normal * 0.0001;
    if (random() < meanScatter) {
      low *= select(scatterLow / meanScatter, vec4f(1.0), scatterLow == vec4f(meanScatter));
      high *= select(scatterHigh / meanScatter, vec4f(1.0), scatterHigh == vec4f(meanScatter));
      direction = normalize(normal + sphere());
      scattered = true;
    } else {
      low *= select(
        (vec4f(1.0) - scatterLow) / (1.0 - meanScatter), vec4f(1.0), scatterLow == vec4f(meanScatter));
      high *= select(
        (vec4f(1.0) - scatterHigh) / (1.0 - meanScatter), vec4f(1.0), scatterHigh == vec4f(meanScatter));
      direction = reflect(direction, normal);
    }
  }
}
