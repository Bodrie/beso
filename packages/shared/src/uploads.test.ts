import { uploadKeySchema, uploadResponseSchema } from './uploads.js';

describe('uploadKeySchema', () => {
  it('accepts kind/uuid.webp keys only', () => {
    expect(
      uploadKeySchema.safeParse('avatar/01a13ed6-d3ec-71cb-b39f-fbc256a293b9.webp').success,
    ).toBe(true);
    expect(
      uploadKeySchema.safeParse('group/01a13ed6-d3ec-71cb-b39f-fbc256a293b9.webp').success,
    ).toBe(true);
    for (const bad of [
      'avatar/01a13ed6-d3ec-71cb-b39f-fbc256a293b9.png',
      'other/01a13ed6-d3ec-71cb-b39f-fbc256a293b9.webp',
      'avatar/../../.env',
      'avatar/x.webp',
    ]) {
      expect(uploadKeySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('uploadResponseSchema', () => {
  it('describes what POST /uploads returns', () => {
    const payload = {
      key: 'post/01a13ed6-d3ec-71cb-b39f-fbc256a293b9.webp',
      url: 'http://localhost:3000/api/v1/uploads/post/01a13ed6-d3ec-71cb-b39f-fbc256a293b9.webp',
      width: 1200,
      height: 800,
      bytes: 54321,
    };
    expect(uploadResponseSchema.parse(payload)).toEqual(payload);
  });
});
