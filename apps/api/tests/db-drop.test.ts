import { expect, spyOn, test } from 'bun:test';
import { dropThrowaway } from './support/db.js';

test('a drop that keeps failing with 42501 resolves and warns once', async () => {
  let calls = 0;
  const admin = {
    unsafe: async () => {
      calls++;
      throw Object.assign(new Error('must be a member of the role whose process is being terminated'), { code: '42501' });
    },
  };
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(dropThrowaway(admin, 't_x', 1)).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test('a drop that succeeds on retry does not warn', async () => {
  let calls = 0;
  const admin = {
    unsafe: async () => {
      if (++calls < 2) throw new Error('55006');
    },
  };
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await dropThrowaway(admin, 't_x', 1);
    expect(calls).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
