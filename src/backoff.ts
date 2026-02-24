/** Exponential backoff with a maximum delay. */
export class Backoff {
  private current: number;

  constructor(
    private readonly initial: number,
    private readonly max: number,
  ) {
    this.current = initial;
  }

  next(): number {
    const d = Math.min(this.current, this.max);
    this.current = Math.min(this.current * 2, this.max);
    return d;
  }

  reset(): void {
    this.current = this.initial;
  }
}
