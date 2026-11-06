//! Seeded gradient noise (Perlin 2D/3D), fBm, ridged multifractal, Worley.

#[inline]
fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^= x >> 16;
    x
}

#[inline]
pub fn hash2(seed: u32, x: i32, z: i32) -> u32 {
    hash(seed ^ hash((x as u32).wrapping_mul(0x9E3779B1) ^ hash(z as u32).wrapping_add(0x85EBCA77)))
}

#[inline]
pub fn hash3(seed: u32, x: i32, y: i32, z: i32) -> u32 {
    hash(hash2(seed, x, z) ^ (y as u32).wrapping_mul(0xC2B2AE3D))
}

/// Uniform float in [0,1) from a hash.
#[inline]
pub fn unit(h: u32) -> f64 {
    (h >> 8) as f64 / (1u32 << 24) as f64
}

#[inline]
fn fade(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline]
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[inline]
fn grad2(h: u32, x: f64, z: f64) -> f64 {
    match h & 7 {
        0 => x + z,
        1 => x - z,
        2 => -x + z,
        3 => -x - z,
        4 => x,
        5 => -x,
        6 => z,
        _ => -z,
    }
}

/// 2D Perlin noise, roughly in [-1, 1].
pub fn perlin2(seed: u32, x: f64, z: f64) -> f64 {
    let (xi, zi) = (x.floor() as i32, z.floor() as i32);
    let (xf, zf) = (x - xi as f64, z - zi as f64);
    let (u, v) = (fade(xf), fade(zf));
    let a = grad2(hash2(seed, xi, zi), xf, zf);
    let b = grad2(hash2(seed, xi + 1, zi), xf - 1.0, zf);
    let c = grad2(hash2(seed, xi, zi + 1), xf, zf - 1.0);
    let d = grad2(hash2(seed, xi + 1, zi + 1), xf - 1.0, zf - 1.0);
    lerp(lerp(a, b, u), lerp(c, d, u), v) * std::f64::consts::FRAC_1_SQRT_2
}

#[inline]
fn grad3(h: u32, x: f64, y: f64, z: f64) -> f64 {
    let h = h & 15;
    let u = if h < 8 { x } else { y };
    let v = if h < 4 { y } else if h == 12 || h == 14 { x } else { z };
    (if h & 1 == 0 { u } else { -u }) + (if h & 2 == 0 { v } else { -v })
}

/// 3D Perlin noise, roughly in [-1, 1].
pub fn perlin3(seed: u32, x: f64, y: f64, z: f64) -> f64 {
    let (xi, yi, zi) = (x.floor() as i32, y.floor() as i32, z.floor() as i32);
    let (xf, yf, zf) = (x - xi as f64, y - yi as f64, z - zi as f64);
    let (u, v, w) = (fade(xf), fade(yf), fade(zf));
    let g = |dx: i32, dy: i32, dz: i32| grad3(hash3(seed, xi + dx, yi + dy, zi + dz), xf - dx as f64, yf - dy as f64, zf - dz as f64);
    let x00 = lerp(g(0, 0, 0), g(1, 0, 0), u);
    let x10 = lerp(g(0, 1, 0), g(1, 1, 0), u);
    let x01 = lerp(g(0, 0, 1), g(1, 0, 1), u);
    let x11 = lerp(g(0, 1, 1), g(1, 1, 1), u);
    lerp(lerp(x00, x10, v), lerp(x01, x11, v), w)
}

/// Fractal Brownian motion in about [-1, 1]. `scale` is the feature size in blocks.
pub fn fbm2(seed: u32, x: f64, z: f64, scale: f64, octaves: u32) -> f64 {
    let mut sum = 0.0;
    let mut amp = 1.0;
    let mut norm = 0.0;
    let mut f = 1.0 / scale.max(1e-6);
    for o in 0..octaves.max(1) {
        sum += amp * perlin2(seed.wrapping_add(o * 1013), x * f, z * f);
        norm += amp;
        amp *= 0.5;
        f *= 2.0;
    }
    sum / norm
}

/// Ridged multifractal in [0, 1]: sharp crests, good for mountain ridges.
pub fn ridged2(seed: u32, x: f64, z: f64, scale: f64, octaves: u32) -> f64 {
    let mut sum = 0.0;
    let mut amp = 1.0;
    let mut norm = 0.0;
    let mut f = 1.0 / scale.max(1e-6);
    let mut weight = 1.0;
    for o in 0..octaves.max(1) {
        let n = 1.0 - perlin2(seed.wrapping_add(o * 7919), x * f, z * f).abs() * 1.4;
        let n = n.clamp(0.0, 1.0);
        let n = n * n * weight;
        weight = (n * 2.0).clamp(0.0, 1.0);
        sum += n * amp;
        norm += amp;
        amp *= 0.5;
        f *= 2.0;
    }
    sum / norm
}

/// Worley (cellular) noise: distance to nearest feature point, in cell units (~[0, 1]).
pub fn worley2(seed: u32, x: f64, z: f64, scale: f64) -> f64 {
    let (x, z) = (x / scale, z / scale);
    let (xi, zi) = (x.floor() as i32, z.floor() as i32);
    let mut best = f64::MAX;
    for dz in -1..=1 {
        for dx in -1..=1 {
            let h = hash2(seed, xi + dx, zi + dz);
            let px = (xi + dx) as f64 + unit(h);
            let pz = (zi + dz) as f64 + unit(hash(h));
            let d = (px - x).powi(2) + (pz - z).powi(2);
            if d < best {
                best = d;
            }
        }
    }
    best.sqrt()
}

/// Small deterministic RNG (xorshift) for placement.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) | 1)
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    pub fn f(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn range(&mut self, lo: i32, hi: i32) -> i32 {
        if hi <= lo {
            return lo;
        }
        lo + (self.next_u64() % (hi - lo + 1) as u64) as i32
    }
    pub fn chance(&mut self, p: f64) -> bool {
        self.f() < p
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        let mut lo: f64 = 0.0;
        let mut hi: f64 = 0.0;
        for i in 0..10000 {
            let v = fbm2(3, i as f64 * 1.37, i as f64 * 0.71, 50.0, 4);
            lo = lo.min(v);
            hi = hi.max(v);
            let r = ridged2(3, i as f64, -(i as f64), 80.0, 4);
            assert!((0.0..=1.0).contains(&r));
        }
        assert!(lo > -1.2 && hi < 1.2 && hi - lo > 0.5);
    }
}
