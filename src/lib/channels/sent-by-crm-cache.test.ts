import { describe, it, expect, beforeEach, vi } from 'vitest';
import { markSentByCrm, wasSentByCrm, __resetSentByCrmCacheForTests } from './sent-by-crm-cache';

describe('sent-by-crm-cache', () => {
  beforeEach(() => {
    __resetSentByCrmCacheForTests();
    vi.useRealTimers();
  });

  it('reports a marked id as sent-by-crm', () => {
    markSentByCrm('wamid.1');
    expect(wasSentByCrm('wamid.1')).toBe(true);
  });

  it('reports an unmarked id as not sent-by-crm', () => {
    expect(wasSentByCrm('wamid.never-marked')).toBe(false);
  });

  it('expires a marker after the TTL window', () => {
    vi.useFakeTimers();
    markSentByCrm('wamid.2');
    expect(wasSentByCrm('wamid.2')).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(wasSentByCrm('wamid.2')).toBe(false);
    vi.useRealTimers();
  });
});
