import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireRole } = vi.hoisted(() => ({ mockRequireRole: vi.fn() }));

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return { ...actual, requireRole: mockRequireRole };
});

let mockRow: Record<string, unknown> | null;
let lastUpdate: { patch: Record<string, unknown>; id: string; accountId: string; status: string } | null;

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'scheduled_messages') throw new Error(`unexpected table: ${table}`);
      return {
        update: (patch: Record<string, unknown>) => {
          let id = '';
          let accountId = '';
          let status = '';
          const builder = {
            eq: (col: string, val: string) => {
              if (col === 'id') id = val;
              if (col === 'account_id') accountId = val;
              if (col === 'status') status = val;
              return builder;
            },
            select: () => builder,
            maybeSingle: async () => {
              lastUpdate = { patch, id, accountId, status };
              if (!mockRow || mockRow.id !== id || mockRow.account_id !== accountId || mockRow.status !== status) {
                return { data: null, error: null };
              }
              return { data: { id }, error: null };
            },
          };
          return builder;
        },
      };
    },
  }),
}));

import { DELETE } from './route';
import { ForbiddenError } from '@/lib/auth/account';

function req() {
  return new Request('http://localhost/api/scheduled-messages/sched-1', { method: 'DELETE' });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  mockRequireRole.mockReset().mockResolvedValue({
    supabase: {}, userId: 'user-1', accountId: 'acc-1', role: 'agent',
    account: { id: 'acc-1', name: 'Acc' },
  });
  mockRow = { id: 'sched-1', account_id: 'acc-1', status: 'pending' };
  lastUpdate = null;
});

describe('DELETE /api/scheduled-messages/[id]', () => {
  it('403s when the caller lacks the agent role', async () => {
    mockRequireRole.mockRejectedValue(new ForbiddenError("This action requires the 'agent' role or higher"));
    const res = await DELETE(req(), params('sched-1'));
    expect(res.status).toBe(403);
  });

  it('cancels a pending row scoped to the caller\'s account', async () => {
    const res = await DELETE(req(), params('sched-1'));
    expect(res.status).toBe(200);
    expect(lastUpdate).toMatchObject({ patch: { status: 'cancelled' }, id: 'sched-1', accountId: 'acc-1', status: 'pending' });
    expect((await res.json()).status).toBe('cancelled');
  });

  it('404s when the row does not exist', async () => {
    mockRow = null;
    const res = await DELETE(req(), params('sched-1'));
    expect(res.status).toBe(404);
  });

  it('404s when the row belongs to a different account (never leaks existence across accounts)', async () => {
    mockRow = { id: 'sched-1', account_id: 'other-acc', status: 'pending' };
    const res = await DELETE(req(), params('sched-1'));
    expect(res.status).toBe(404);
  });

  it('404s when the row is already sent/cancelled/sending (only pending can be cancelled)', async () => {
    mockRow = { id: 'sched-1', account_id: 'acc-1', status: 'sent' };
    const res = await DELETE(req(), params('sched-1'));
    expect(res.status).toBe(404);
  });
});
