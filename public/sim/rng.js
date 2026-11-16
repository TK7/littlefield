// Seeded random numbers, identical to sim/littlefield/rng.py (mulberry32).
// The same seed gives the same stream in Python and JavaScript.

export class Rng {
  constructor(seed) { this.a = seed >>> 0; }

  random() {
    this.a = (this.a + 0x6D2B79F5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  exponential(rate) { return -Math.log(1 - this.random()) / rate; }

  // Mean `base`, coefficient of variation `cv`: a constant part plus an exponential part.
  process(base, cv) {
    if (cv <= 0) return base;
    return base * ((1 - cv) + cv * this.exponential(1));
  }
}
