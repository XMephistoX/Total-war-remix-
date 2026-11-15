// Small seeded RNG (mulberry32) so battles are reproducible for testing and replays.
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  gauss(): number {
    // Approximate normal distribution, mean 0, sd 1.
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
