import { describe, expect, it } from 'vitest';

import { ADMIN_ACTION_TYPE, PRODUCT_EVENT_NAME } from './metrics';

describe('metric contract constants', () => {
  it('keeps event and admin action values unique', () => {
    const events = Object.values(PRODUCT_EVENT_NAME);
    const actions = Object.values(ADMIN_ACTION_TYPE);
    expect(new Set(events).size).toBe(events.length);
    expect(new Set(actions).size).toBe(actions.length);
  });
});
