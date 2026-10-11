import { describe, expect, it } from 'vitest';
import { Reservations, SerialQueue } from './concurrency.js';

describe('Reservations', () => {
  it('exchanges held funds for actual spend without double-counting and frees unused funds', async () => {
    let spent = 0;
    const reservations = new Reservations(() => 100 - spent);
    expect(reservations.reserve('A', 60)).toBe(true);
    expect(reservations.reserve('B', 60)).toBe(false);
    expect(reservations.remaining()).toBe(40);
    expect(reservations.remaining('A')).toBe(100);
    const awakened = reservations.waiting('B');
    spent = 20;
    reservations.settle('A', 20);
    await awakened;
    expect(reservations.remaining()).toBe(40);
    reservations.release('A');
    expect(reservations.remaining()).toBe(80);
    expect(reservations.reserve('B', 60)).toBe(true);
    expect(reservations.waiting('B')).toBeNull();
  });
});

describe('SerialQueue', () => {
  it('does not strand later operations when an earlier operation fails', async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => { throw new Error('failed write'); });
    const next = queue.run(async () => 'next write');
    await expect(failed).rejects.toThrow('failed write');
    await expect(next).resolves.toBe('next write');
  });
});
